'use strict'

const pull = require('pull-stream')
const handshake = require('pull-handshake')
const Connection = require('interface-connection').Connection
const mafmt = require('mafmt')
const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const isFunction = require('lodash.isfunction')
const multiaddr = require('multiaddr')
const lp = require('pull-length-prefixed')
const debug = require('debug')
const codes = require('./codes')
const waterfall = require('async/waterfall')

const log = debug('libp2p:circuit:dialer')
log.err = debug('libp2p:circuit:error:dialer')

const multicodec = require('./multicodec')

const createListener = require('./listener')

class Dialer {
  /**
   * Creates an instance of Dialer.
   * @param {Swarm} swarm - the swarm
   * @param {any} options - config options
   * @param {Function} handler - the handler that is passed to the listener on transport instantiation
   *
   * @memberOf Dialer
   */
  constructor (swarm, options, handler) {
    if (isFunction(options)) {
      handler = options
      options = {}
    }

    if (!handler) {
      handler = () => {}
    }

    this.swarm = swarm
    this.relayPeers = new Map()
    this.options = options
    this.handler = handler // this handler is passed to the listener

    // get all the relay addresses for this swarm
    const relays = this.filter(swarm._peerInfo.multiaddrs)

    // if no explicit relays, add a default relay addr
    if (relays.length === 0) {
      this.swarm._peerInfo.multiaddr.add(`/p2p-circuit/ipfs/${this.swarm._peerInfo.id.toB58String()}`)
    }

    this.dialSwarmRelays(relays)

    this.swarm.on('peer-mux-established', this.addRelayPeer.bind(this))
    this.swarm.on('peer-mux-closed', (peerInfo) => {
      this.relayPeers.delete(peerInfo.id.toB58String())
    })
  }

  /**
   * Dial the relays in the Addresses.Swarm config
   *
   * @param relays
   */
  dialSwarmRelays (relays) {
    // if we have relay addresses in swarm config, then dial those relays
    this.swarm.on('listening', () => {
      relays.forEach((relay) => {
        let relaySegments = relay.toString().split('/p2p-circuit').filter(segment => segment.length)
        relaySegments.forEach((relaySegment) => {
          this.addRelayPeer(relaySegment)
        })
      })
    })
  }

  /**
   * Dial a peer over a relay
   *
   * @param {multiaddr} ma - the multiaddr of the peer to dial
   * @param {Object} options - dial options
   * @param {Function} cb - a callback called once dialed
   * @returns {Connection} - the connection
   *
   * @memberOf Dialer
   */
  dial (ma, options, cb) {
    if (isFunction(options)) {
      cb = options
      options = {}
    }

    if (!cb) {
      cb = () => {}
    }

    let dstConn = new Connection()
    let maddrs = multiaddr(ma).toString().split('/p2p-circuit')

    let dstMaddr = maddrs.pop() // the last segment is always our destination peer
    // dial over any relay
    this._onionDial(maddrs, dstMaddr, (err, conn) => {
      if (err) {
        log.err(err)
        return cb(err)
      }
      dstConn.setInnerConn(conn)
      cb(null, dstConn)
    })

    return dstConn
  }

  /**
   * Dial a peer using onion dial - dial all relays in the ma
   * in sequence and circuit dest over the all the pipes
   *
   * @param maddrs
   * @param dst
   * @param cb
   * @private
   */
  _onionDial (maddrs, dst, cb) {
    let relayMa = maddrs.shift()
    let dstMa = maddrs.shift()

    let dial = (dstAddr, relayConn) => {
      if (dstAddr) {
        this._dialPeer(dstAddr, relayConn, (err, conn) => {
          this.relayPeers.set(multiaddr(dstAddr).getPeerId(), conn)
          if (maddrs.length > 0) {
            maddrs.unshift(dstAddr)
            this._onionDial(maddrs, dst, cb)
          }
        })
      } else {
        this._dialPeer(dst, relayConn, (err, conn) => {
          if (err) {
            return cb(err)
          }
          cb(null, conn)
        })
      }
    }

    if (relayMa) {
      this.addRelayPeer(relayMa, (err, relayConn) => {
        if (err) {
          log.err(err)
          return cb(err)
        }

        dial(dstMa, relayConn)
      })
    } else {
      dial()
    }
  }

  /**
   * Dial the destination peer over a relay
   *
   * @param dstMa
   * @param relay
   * @param cb
   * @private
   */
  _dialPeer (dstMa, relay, cb) {
    if (isFunction(relay)) {
      cb = relay
      relay = null
    }

    if (!cb) {
      cb = () => {}
    }

    dstMa = multiaddr(dstMa)
    // if no relay provided, dial on all available relays until one succeeds
    if (!relay) {
      const relays = Array.from(this.relayPeers.values())
      let next = (nextRelay) => {
        if (!nextRelay) {
          let err = `no relay peers were found`
          log.err(err)
          return cb(err)
        }

        this._dialPeer(dstMa, nextRelay, (err, conn) => {
          if (err) {
            log.err(err)
            return next(relays.shift())
          }
          cb(null, new Connection(conn))
        })
      }
      next(relays.shift())
    } else {
      this._negotiateRelay(relay, dstMa, (err, conn) => {
        if (err) {
          log.err(`An error has occurred negotiating the relay connection`, err)
          return cb(err)
        }

        return cb(null, conn)
      })
    }
  }

  /**
   * Create a listener
   *
   * @param {Function} handler
   * @param {any} options
   * @returns {listener}
   */
  createListener (handler) {
    return createListener(this.swarm, handler)
  }

  /**
   * Negotiate the relay connection
   *
   * @param {Connection} conn - a connection to the relay
   * @param {multiaddr} dstMa - the multiaddr of the peer to relay the connection for
   * @param {Function} cb - a callback with that return the negotiated relay connection
   * @returns {void}
   *
   * @memberOf Dialer
   */
  _negotiateRelay (conn, dstMa, cb) {
    let src = multiaddr(`/ipfs/${this.swarm._peerInfo.id.toB58String()}`)
    dstMa = multiaddr(dstMa)

    let stream = handshake({timeout: 1000 * 60}, cb)
    let shake = stream.handshake

    log(`negotiating relay for peer ${dstMa.getPeerId()}`)
    const values = [new Buffer(dstMa.toString())]

    pull(
      pull.values(values),
      lp.encode(),
      pull.collect((err, encoded) => {
        if (err) {
          return cb(err)
        }

        shake.write(encoded[0])
        shake.read(3, (err, data) => {
          if (err) {
            log.err(err)
            return cb(err)
          }

          if (Number(data.toString()) !== codes.SUCCESS) {
            cb(new Error(`Got ${data.toString()} error code trying to dial over relay`))
          }

          cb(null, shake.rest())
        })
      })
    )

    pull(stream, conn, stream)
  }

  /**
   * Dial a relay peer by its PeerInfo
   *
   * @param {multiaddr|PeerInfo} peer - the PeerInfo of the relay peer
   * @param {Function} callback - a callback with the connection to the relay peer
   * @returns {Function|void}
   *
   * @memberOf Dialer
   */
  _dialRelay (peer, callback) {
    let b58Id
    if (peer instanceof multiaddr || (typeof peer === 'string' || peer instanceof String)) {
      const relayMa = multiaddr(peer)
      b58Id = relayMa.getPeerId()
      peer = new PeerInfo(PeerId.createFromB58String(relayMa.getPeerId()))
    } else {
      b58Id = peer.id.toB58String()
    }

    log('dialing relay %s', b58Id)
    this.swarm.dial(peer, multicodec.hop, (err, conn) => {
      if (err) {
        return callback(err)
      }

      callback(null, conn)
    })
  }

  /**
   * Connect to a relay peer
   *
   * @param {multiaddr|PeerInfo} peer - the PeerInfo of the relay
   * @param {Function} cb
   * @returns {void}
   *
   * @memberOf Dialer
   */
  addRelayPeer (peer, cb) {
    cb = cb || (() => {})

    let b58Id
    if (peer instanceof multiaddr || (typeof peer === 'string' || peer instanceof String)) {
      const relayMa = multiaddr(peer)
      b58Id = relayMa.getPeerId()
      peer = new PeerInfo(PeerId.createFromB58String(relayMa.getPeerId()))
    } else {
      b58Id = peer.id.toB58String()
    }

    const relay = this.relayPeers.get(b58Id)
    if (relay) {
      cb(null, relay)
    }

    const relayConn = new Connection()
    relayConn.setPeerInfo(peer)
    // attempt to dia the relay so that we have a connection
    this._dialRelay(peer, (err, conn) => {
      if (err) {
        log.err(err)
        return cb(err)
      }

      relayConn.setInnerConn(conn)
      this.relayPeers.set(b58Id, relayConn)
      cb(null, relayConn)
    })
  }

  /**
   * Filter check for all multiaddresses
   * that this transport can dial on
   *
   * @param {any} multiaddrs
   * @returns {Array<multiaddr>}
   *
   * @memberOf Dialer
   */
  filter (multiaddrs) {
    if (!Array.isArray(multiaddrs)) {
      multiaddrs = [multiaddrs]
    }
    return multiaddrs.filter((ma) => {
      return mafmt.Circuit.matches(ma)
    })
  }
}

module.exports = Dialer
