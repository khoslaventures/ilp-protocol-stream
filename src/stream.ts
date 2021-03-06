import createLogger from 'ilp-logger'
import BigNumber from 'bignumber.js'
import { Duplex } from 'stream'
import { DataQueue } from './util/data-queue'
import { OffsetSorter } from './util/data-offset-sorter'
require('source-map-support').install()

const DEFAULT_TIMEOUT = 60000

export interface StreamOpts {
  id: number,
  isServer: boolean
}

export interface SendOpts {
  timeout?: number
}

export interface ReceiveOpts {
  timeout?: number
}

/**
 * Class used to send money and data over a [Connection]{@link Connection}.
 *
 * This exposes the Node [Duplex Stream](https://nodejs.org/dist/latest-v10.x/docs/api/stream.html#stream_class_stream_duplex) interface for sending data,
 * as well as additional functions for sending money.
 */
export class DataAndMoneyStream extends Duplex {
  readonly id: number

  /** @private */
  _errorMessage?: string
  /** @private */
  _remoteClosed: boolean
  /** @private */
  _remoteReceiveMax: BigNumber
  /** @private */
  _remoteReceived: BigNumber
  /** @private */
  _remoteMaxOffset: number
  /** @private */
  _sentEnd: boolean
  /** @private */
  _remoteSentEnd: boolean

  protected log: any
  protected isServer: boolean

  protected _totalSent: BigNumber
  protected _totalReceived: BigNumber
  protected _sendMax: BigNumber
  protected _receiveMax: BigNumber
  protected _outgoingHeldAmount: BigNumber

  protected closed: boolean
  protected holds: { [id: string]: BigNumber }

  protected _incomingData: OffsetSorter
  protected _outgoingData: DataQueue
  protected _outgoingDataToRetry: { data: Buffer, offset: number }[]
  protected outgoingOffset: number

  protected emittedEnd: boolean
  protected emittedClose: boolean

  constructor (opts: StreamOpts) {
    // Half-opened streams are not supported, support may be added in the future.
    super({ allowHalfOpen: false })
    this.id = opts.id
    this.isServer = opts.isServer
    this.log = createLogger(`ilp-protocol-stream:${this.isServer ? 'Server' : 'Client'}:Stream:${this.id}`)
    this.log.info('new stream created')

    this._totalSent = new BigNumber(0)
    this._totalReceived = new BigNumber(0)
    this._sendMax = new BigNumber(0)
    this._receiveMax = new BigNumber(0)
    this._outgoingHeldAmount = new BigNumber(0)

    this._sentEnd = false
    this._remoteSentEnd = false
    this.closed = false
    this.holds = {}

    this._incomingData = new OffsetSorter()
    this._outgoingData = new DataQueue()
    // TODO we might want to merge this with the _outgoingData queue data structure
    this._outgoingDataToRetry = []
    this.outgoingOffset = 0

    this._remoteClosed = false
    this._remoteReceived = new BigNumber(0)
    this._remoteReceiveMax = new BigNumber(Infinity)
    // TODO should we have a different default?
    this._remoteMaxOffset = 16384 // 16kb

    this.emittedEnd = false
    this.emittedClose = false
    this.once('end', () => {
      this.emittedEnd = true
    })
    this.once('close', () => {
      this.emittedClose = true
    })
  }

  /**
   * Total amount sent so far, denominated in the connection plugin's units.
   */
  get totalSent (): string {
    return this._totalSent.toString()
  }

  /**
   * Total amount received so far, denominated in the connection plugin's units.
   */
  get totalReceived (): string {
    return this._totalReceived.toString()
  }

  /**
   * The current limit up to which the stream will try to send, denominated in the connection plugin's units.
   * (If the `sendMax` is greater than the `totalSent`, the stream will continue to send the difference)
   */
  get sendMax (): string {
    return this._sendMax.toString()
  }

  /**
   * The current limit up to which the stream will try to send, denominated in the connection plugin's units.
   * (If the `receiveMax` is greater than the `totalReceived`, the stream will continue to receive money when the other side sends it)
   */
  get receiveMax (): string {
    return this._receiveMax.toString()
  }

  /**
   * Number of bytes buffered and waiting to be read
   *
   * This property exists on streams after Node 9.4 so it is added here for backwards compatibility
   */
  get readableLength (): number {
    // stream.readableLength was only added in Node v9.4.0
    const readableLength = super.readableLength || (this['_readableState'] && this['_readableState'].length) || 0
    return readableLength + this._incomingData.byteLength()
  }

  /**
   * Number of bytes buffered and waiting to be sent
   *
   * This property exists on streams after Node 9.4 so it is added here for backwards compatibility
   */
  get writableLength (): number {
    // stream.writableLength was only added in Node v9.4.0
    const writableLength = super.writableLength || (this['_writableState'] && this['_writableState'].length) || 0
    return writableLength
  }

  /**
   * Returns the value of readableHighWaterMark passed when constructing this stream
   *
   * This property exists on streams after Node 8.10 so it is added here for backwards compatibility
   */
  get readableHighWaterMark (): number {
    /* tslint:disable-next-line:strict-type-predicates */
    if (typeof super.readableHighWaterMark === 'number') {
      return super.readableHighWaterMark
    } else {
      return this['_readableState'].highWaterMark
    }
  }

  /**
   * Returns the value of writableHighWaterMark passed when constructing this stream
   *
   * This property exists on streams after Node 8.10 so it is added here for backwards compatibility
   */
  get writableHighWaterMark (): number {
    /* tslint:disable-next-line:strict-type-predicates */
    if (typeof super.writableHighWaterMark === 'number') {
      return super.writableHighWaterMark
    } else {
      return this['_writableState'].highWaterMark
    }
  }

  /**
   * Returns true if the stream is open for sending and/or receiving.
   */
  isOpen (): boolean {
    return !this.closed
  }

  /**
   * Set the total amount this stream will send, denominated in the connection plugin's units.
   * Note that this is absolute, not relative so calling `setSendMax(100)` twice will only send 100 units.
   */
  setSendMax (limit: BigNumber.Value): void {
    if (this.closed) {
      throw new Error('Stream already closed')
    }
    const sendMax = new BigNumber(limit)
    if (this._totalSent.isGreaterThan(sendMax)) {
      this.log.debug(`cannot set sendMax to ${sendMax} because we have already sent: ${this._totalSent}`)
      throw new Error(`Cannot set sendMax lower than the totalSent`)
    }
    if (!sendMax.isFinite()) {
      throw new Error('sendMax must be finite')
    }
    this.log.debug(`setting sendMax to ${sendMax}`)
    this._sendMax = sendMax
    this.emit('_maybe_start_send_loop')
  }

  /**
   * Event fired when money is received
   * @event money
   * @type {string} Amount of money received, encoded as a string to avoid loss of precision
   */

  /**
   * Set the total amount this stream will receive, denominated in the connection plugin's units.
   * Note that this is absolute, not relative so calling `setReceiveMax(100)` twice will only let the stream receive 100 units.
   * @fires money
   */
  setReceiveMax (limit: BigNumber.Value): void {
    if (this.closed) {
      throw new Error('Stream already closed')
    }
    if (this._totalReceived.isGreaterThan(limit)) {
      this.log.debug(`cannot set receiveMax to ${limit} because we have already received: ${this._totalReceived}`)
      throw new Error('Cannot set receiveMax lower than the totalReceived')
    }
    if (this._receiveMax.isGreaterThan(limit)) {
      this.log.debug(`cannot set receiveMax to ${limit} because the current limit is: ${this._receiveMax}`)
      throw new Error('Cannot decrease the receiveMax')
    }
    this.log.debug(`setting receiveMax to ${limit}`)
    this._receiveMax = new BigNumber(limit)
    this.emit('_maybe_start_send_loop')
  }

  /**
   * Set the total amount the stream will send and wait for that amount to be sent.
   * Note that this is absolute, not relative so calling `sendTotal(100)` twice will only send 100 units.
   *
   * This promise will only resolve when the absolute amount specified is reached, so lowering the `sendMax` may cause this not to resolve.
   */
  async sendTotal (limit: BigNumber.Value, opts?: SendOpts): Promise<void> {
    const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT
    if (this._totalSent.isGreaterThanOrEqualTo(limit)) {
      this.log.debug(`already sent ${this._totalSent}, not sending any more`)
      return Promise.resolve()
    }

    this.setSendMax(limit)
    await new Promise((resolve, reject) => {
      const self = this
      function outgoingHandler () {
        if (self._totalSent.isGreaterThanOrEqualTo(limit)) {
          cleanup()
          resolve()
        }
      }
      function endHandler () {
        // Clean up on next tick in case an error was also emitted
        setImmediate(cleanup)
        if ((self._totalSent.isGreaterThanOrEqualTo(limit))) {
          resolve()
        } else {
          self.log.debug(`Stream was closed before the desired amount was sent (target: ${limit}, totalSent: ${self._totalSent})`)
          reject(new Error(`Stream was closed before the desired amount was sent (target: ${limit}, totalSent: ${self._totalSent})`))
        }
      }
      function errorHandler (err: Error) {
        self.log.debug('error waiting for stream to stabilize:', err)
        cleanup()
        reject(new Error(`Stream encountered an error before the desired amount was sent (target: ${limit}, totalSent: ${self._totalSent}): ${err}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out before the desired amount was sent (target: ${limit}, totalSent: ${self._totalSent})`))
      }, timeout)
      function cleanup () {
        clearTimeout(timer)
        self.removeListener('outgoing_money', outgoingHandler)
        self.removeListener('error', errorHandler)
        self.removeListener('end', endHandler)
      }

      this.on('outgoing_money', outgoingHandler)
      this.on('error', errorHandler)
      this.on('end', endHandler)
    })
  }

  /**
   * Set the total amount the stream will receive and wait for that amount to be received.
   * Note that this is absolute, not relative so calling `receiveTotal(100)` twice will only receive 100 units.
   *
   * This promise will only resolve when the absolute amount specified is reached, so lowering the `receiveMax` may cause this not to resolve.
   */
  async receiveTotal (limit: BigNumber.Value, opts?: ReceiveOpts): Promise<void> {
    const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT
    if (this._totalReceived.isGreaterThanOrEqualTo(limit)) {
      this.log.debug(`already received ${this._totalReceived}, not waiting for more`)
      return Promise.resolve()
    }

    this.setReceiveMax(limit)
    await new Promise((resolve, reject) => {
      const self = this
      function moneyHandler () {
        if (self._totalReceived.isGreaterThanOrEqualTo(limit)) {
          cleanup()
          resolve()
        }
      }
      function endHandler () {
        // Clean up on next tick in case an error was also emitted
        setImmediate(cleanup)
        if (self._totalReceived.isGreaterThanOrEqualTo(limit)) {
          resolve()
        } else {
          self.log.debug(`Stream was closed before the desired amount was received (target: ${limit}, totalReceived: ${self._totalReceived})`)
          reject(new Error(`Stream was closed before the desired amount was received (target: ${limit}, totalReceived: ${self._totalReceived})`))
        }
      }
      function errorHandler (err: Error) {
        self.log.debug('error waiting for stream to stabilize:', err)
        cleanup()
        reject(new Error(`Stream encountered an error before the desired amount was received (target: ${limit}, totalReceived: ${self._totalReceived}): ${err}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out before the desired amount was received (target: ${limit}, totalReceived: ${self._totalReceived})`))
      }, timeout)
      function cleanup () {
        clearTimeout(timer)
        self.removeListener('money', moneyHandler)
        self.removeListener('error', errorHandler)
        self.removeListener('end', endHandler)
      }

      this.on('money', moneyHandler)
      this.on('error', errorHandler)
      this.on('end', endHandler)
    })
  }

  /**
   * (Internal) Determine how much more the stream can receive
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _getAmountStreamCanReceive (): BigNumber {
    return this._receiveMax.minus(this._totalReceived)
  }

  /**
   * (Internal) Add money to the stream (from an external source)
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _addToIncoming (amount: BigNumber): void {
    this._totalReceived = this._totalReceived.plus(amount)
    this.log.trace(`received ${amount} (totalReceived: ${this._totalReceived})`)
    this.emit('money', amount.toString())
  }

  /**
   * (Internal) Check how much is available to send
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _getAmountAvailableToSend (): BigNumber {
    if (this.closed) {
      return new BigNumber(0)
    }
    const amountAvailable = this._sendMax.minus(this._totalSent).minus(this._outgoingHeldAmount)
    return BigNumber.maximum(amountAvailable, 0)
  }

  /**
   * (Internal) Hold outgoing balance
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _holdOutgoing (holdId: string, maxAmount?: BigNumber): BigNumber {
    const amountAvailable = this._getAmountAvailableToSend()
    const amountToHold = (maxAmount ? BigNumber.minimum(amountAvailable, maxAmount) : amountAvailable)
    if (amountToHold.isGreaterThan(0)) {
      this._outgoingHeldAmount = this._outgoingHeldAmount.plus(amountToHold)
      this.holds[holdId] = amountToHold
      this.log.trace(`holding outgoing balance. holdId: ${holdId}, amount: ${amountToHold}`)
    }
    return amountToHold
  }

  /**
   * (Internal) Execute hold when money has been successfully transferred
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _executeHold (holdId: string): void {
    if (!this.holds[holdId]) {
      return
    }
    const amount = this.holds[holdId]
    this._outgoingHeldAmount = this._outgoingHeldAmount.minus(amount)
    this._totalSent = this._totalSent.plus(amount)
    delete this.holds[holdId]
    this.log.trace(`executed holdId: ${holdId} for: ${amount}`)
    this.emit('outgoing_money', amount.toString())

    if (this._totalSent.isGreaterThanOrEqualTo(this._sendMax)) {
      this.log.debug('outgoing total sent')
      this.emit('outgoing_total_sent')
    }
  }

  /**
   * (Internal) Cancel hold if sending money failed
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _cancelHold (holdId: string): void {
    if (!this.holds[holdId]) {
      return
    }
    const amount = this.holds[holdId]
    this.log.trace(`cancelled holdId: ${holdId} for: ${amount}`)
    this._outgoingHeldAmount = this._outgoingHeldAmount.minus(amount)
    delete this.holds[holdId]
  }

  /**
   * (Called internally by the Node Stream when the stream ends)
   * @private
   */
  _final (callback: (...args: any[]) => void): void {
    this.log.info('stream is closing')
    // TODO should we emit the event (or return a promise that resolves)
    // after we're done sending all the queued data and money?
    if (!this._sentEnd && !this._remoteSentEnd) {
      this.log.trace('starting another send loop to tell the peer the stream was closed')
      this.emit('_maybe_start_send_loop')
    }
    const finish = (err?: Error) => {
      if (err) {
        this.log.debug(`error waiting for money to be sent:`, err)
      }
      this.log.info('stream ended')
      this.closed = true
      // Only emit the 'close' & 'end' events if the stream doesn't automatically
      setImmediate(() => {
        if (!this.emittedEnd) {
          this.emittedEnd = true
          this.safeEmit('end')
        }
        if (!this.emittedClose) {
          this.emittedClose = true
          this.safeEmit('close')
        }
      })
      callback(err)
    }

    if (this._remoteSentEnd || this._sendMax.isLessThanOrEqualTo(this._totalSent)) {
      finish()
    } else {
      this.log.info('waiting to finish sending money before ending stream')

      new Promise((resolve, reject) => {
        this.once('outgoing_total_sent', resolve)
        this.once('_send_loop_finished', resolve)
        this.once('error', (error: Error) => reject(error))
      })
      .then(() => finish())
      .catch(finish)
    }
  }

  /**
   * (Called internally by the Node Stream when stream.destroy is called)
   * @private
   */
  _destroy (error: Error | undefined | null, callback: (...args: any[]) => void): void {
    this.log.error('destroying stream because of error:', error)
    this.closed = true
    if (error) {
      this._errorMessage = error.message
    }
    // Only emit the 'close' & 'end' events if the stream doesn't automatically
    setImmediate(() => {
      if (!this.emittedEnd) {
        this.emittedEnd = true
        this.safeEmit('end')
      }
      if (!this.emittedClose) {
        this.emittedClose = true
        this.safeEmit('close')
      }
    })
    callback(error)
  }

  /**
   * (Called internally by the Node Stream when stream.write is called)
   * @private
   */
  _write (chunk: Buffer, encoding: string, callback: (...args: any[]) => void): void {
    this.log.trace(`${chunk.length} bytes written to the outgoing data queue`)
    this._outgoingData.push(chunk, callback)
    this.emit('_maybe_start_send_loop')
  }

  /**
   * (Called internally by the Node Stream when stream.write is called)
   * @private
   */
  _writev (chunks: { chunk: Buffer, encoding: string }[], callback: (...args: any[]) => void): void {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      this.log.trace(`${chunk.chunk.length} bytes written to the outgoing data queue`)
      // Only call the callback when the last chunk has been sent out
      if (i === chunks.length - 1) {
        this._outgoingData.push(chunk.chunk, callback)
      } else {
        this._outgoingData.push(chunk.chunk)
      }
    }
    this.emit('_maybe_start_send_loop')
  }

  /**
   * (Called internally by the Node Stream when stream.read is called)
   * @private
   */
  _read (size: number): void {
    const data = this._incomingData.read()
    if (!data) {
      // Let the peer know that this stream can receive more data.
      // Don't call immediately since looping before the read() has finished
      // would report incorrect offsets.
      if (this['readableFlowing'] !== true) {
        process.nextTick(() => this.emit('_maybe_start_send_loop'))
      }
      return
    }
    this.push(data)
    if (data.length < size) {
      this._read(size - data.length)
    }
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _hasDataToSend (): boolean {
    return !this._outgoingData.isEmpty() || this._outgoingDataToRetry.length > 0
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _getAvailableDataToSend (size: number): { data: Buffer | undefined, offset: number } {
    // See if we have data that needs to be resent
    if (this._outgoingDataToRetry.length > 0) {
      const toSend = this._outgoingDataToRetry[0]
      if (toSend.data.length > size) {
        const data = toSend.data.slice(0, size)
        const offset = toSend.offset
        toSend.data = toSend.data.slice(size)
        toSend.offset = toSend.offset + size
        return { data, offset }
      } else {
        return this._outgoingDataToRetry.shift()!
      }
    }

    // Send new data if the remote can receive more data
    const maxBytes = Math.min(size, this._remoteMaxOffset - this.outgoingOffset)
    const offset = this.outgoingOffset
    const data = this._outgoingData.read(maxBytes)
    if (data && data.length > 0) {
      this.outgoingOffset += data.length
      this.log.trace(`${data.length} bytes taken from the outgoing data queue`)
    }
    return { data, offset }
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _resendOutgoingData (data: Buffer, offset: number) {
    this.log.trace(`re-queuing ${data.length} bytes of data starting at offset ${offset}`)
    this._outgoingDataToRetry.push({ data, offset })
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _isDataBlocked (): number | undefined {
    if (this._remoteMaxOffset < this.outgoingOffset + this._outgoingData.byteLength()) {
      return this.outgoingOffset + this._outgoingData.byteLength()
    }
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _getOutgoingOffsets (): { current: number, max: number } {
    return {
      current: this.outgoingOffset,
      max: this.outgoingOffset + this._outgoingData.byteLength()
    }
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _getIncomingOffsets (): { max: number, current: number, maxAcceptable: number } {
    return {
      max: this._incomingData.maxOffset,
      current: this._incomingData.readOffset,
      maxAcceptable: this._incomingData.readOffset + this.readableHighWaterMark - this.readableLength
    }
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _pushIncomingData (data: Buffer, offset: number) {
    this._incomingData.push(data, offset)

    this._read(this.readableHighWaterMark - this.readableLength)
  }

  /**
   * (Used by the Connection class but not meant to be part of the public API)
   * @private
   */
  _remoteEnded (err?: Error): void {
    this.log.info('remote closed stream')
    this._remoteSentEnd = true
    this._remoteClosed = true
    if (err) {
      this.destroy(err)
    } else {
      this.push(null)
      this.end()
    }
  }

  protected safeEmit (event: string, ...args: any[]) {
    try {
      args.unshift(event)
      this.emit.apply(this, args)
    } catch (err) {
      this.log.debug(`error in ${event} handler:`, err)
    }
  }
}
