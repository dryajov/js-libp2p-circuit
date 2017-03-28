'use strict'

const pull = require('pull-stream')
const lp = require('pull-length-prefixed')
const handshake = require('pull-handshake')
const debug = require('debug')
const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const EE = require('events').EventEmitter
const multiaddr = require('multiaddr')
const codes = require('./codes')

const multicodec = require('./multicodec')

const log = debug('libp2p:circuit:relay')
log.err = debug('libp2p:circuit:error:relay')

class Relay extends EE {

  /**
   * Construct a Circuit object
   *
   * This class will handle incoming circuit connections and
   * either start a relay or hand the relayed connection to
   * the swarm
   *
   * @param {any} options - configuration for Relay
   */
  constructor (options) {
    super()
    this.config = options
    this.libp2p
  }

  /**
   * Mount the relay
   */
  mount (libp2p) {
    this.libp2p = libp2p
    this.libp2p.handle(multicodec.hop, (proto, conn) => {
      let stream = handshake({timeout: 1000 * 60})
      let shake = stream.handshake

      pull(
        stream,
        conn,
        stream
      )

      lp.decodeFromReader(shake, (err, msg) => {
        if (err) {
          log.err(err)
          return
        }

        let addr = multiaddr(msg.toString()) // read the src multiaddr

        if (addr.getPeerId() === this.libp2p.peerInfo.id.toB58String()) {
          this.emit('error', '280')
          shake.write('280')
          return
        }

        this.circuit(shake.rest(), addr, (err) => {
          if (err) {
            log.err(err)
            this.emit('error', err)
          }

          this.emit('circuit')
        })
      })
    })
  }

  /**
   * Write error message to conn
   *
   * @param conn
   * @param errCode
   * @param cb
   */
  writeErr (conn, errCode, cb) {
    let stream = handshake({timeout: 1000 * 60}, cb)
    let shake = stream.handshake

    // create handshake stream
    pull(
      stream,
      dstConn,
      stream
    )

    pull(
      pull.values([errCode]),
      lp.encode(),
      pull.collect((err, encoded) => {
        if (err) {
          return cb(err)
        }

        shake.write(encoded[0])
        // circuit the src and dst streams
        pull(
          conn,
          shake.rest(),
          conn
        )
        cb()
      })
    )
  }

  /**
   * The handler called to process a connection
   *
   * @param {Connection} conn
   * @param {Multiaddr} dstAddr
   * @param {Function} cb
   *
   * @return {void}
   */
  circuit (conn, dstAddr, cb) {
    if (this.libp2p.peerInfo.id.toB58String() === multiaddr(dstAddr)) {
      this.writeErr(conn, codes.HOP.CANT_CONNECT_TO_SELF, () => {
        return cb(`Can't dial to itself!`)
      })
    }

    this._dialPeer(dstAddr, (err, dstConn) => {
      if (err) {
        log.err(err)
        return cb(err)
      }

      let stream = handshake({timeout: 1000 * 60}, cb)
      let shake = stream.handshake

      // create handshake stream
      pull(
        stream,
        dstConn,
        stream
      )

      pull(
        pull.values([new Buffer(`/ipfs/${multiaddr(dstAddr).getPeerId()}`)]),
        lp.encode(),
        pull.collect((err, encoded) => {
          if (err) {
            return cb(err)
          }

          shake.write(encoded[0])
          // circuit the src and dst streams
          pull(
            conn,
            shake.rest(),
            conn
          )
          cb()
        })
      )
    })
  }

  _dialPeer (ma, callback) {
    const peerInfo = new PeerInfo(PeerId.createFromB58String(ma.getPeerId()))
    peerInfo.multiaddr.add(ma)
    this.libp2p.dialByPeerInfo(peerInfo, multicodec.stop, (err, conn) => {
      if (err) {
        log.err(err)
        return callback(err)
      }

      callback(null, conn)
    })
  }
}

module.exports = Relay
