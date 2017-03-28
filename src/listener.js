'use strict'

const includes = require('lodash/includes')
const pull = require('pull-stream')
const multicodec = require('./multicodec')
const EE = require('events').EventEmitter
const lp = require('pull-length-prefixed')
const multiaddr = require('multiaddr')
const handshake = require('pull-handshake')
const Connection = require('interface-connection').Connection
const mafmt = require('mafmt')
const codes = require('./codes')

const debug = require('debug')

const log = debug('libp2p:circuit:listener')
log.err = debug('libp2p:circuit:error:listener')

module.exports = (swarm, handler) => {
  const listener = new EE()

  listener.listen = (ma, cb) => {
    cb = cb || (() => {})

    swarm.handle(multicodec.stop, (proto, conn) => {
      conn.getPeerInfo((err, peerInfo) => {
        if (err) {
          log.err('Failed to identify incoming conn', err)
          return handler(err, null)
        }

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
            return cb(err)
          }

          peerInfo.multiaddr.add(multiaddr(msg.toString())) // add the addr we got along with the relay request
          shake.write(String(codes.SUCCESS))

          let newConn = new Connection(shake.rest(), conn)
          newConn.setPeerInfo(peerInfo)
          listener.emit('connection', newConn)
          handler(null, newConn)
        })
      })
    })

    listener.emit('listen')
    cb()
  }

  listener.close = (cb) => {
    // TODO: should we close/abort the connection here?
    // spdy-transport throws a `Error: socket hang up`
    // on swarm stop right now, I think it's because
    // the socket is abruptly closed?
    swarm.unhandle(multicodec.stop)
    listener.emit('close')
    cb()
  }

  listener.getAddrs = (callback) => {
    let addrs = swarm._peerInfo.distinctMultiaddr().filter((addr) => {
      return mafmt.Circuit.matches(addr)
    })

    const listenAddrs = []
    addrs.forEach((addr) => {
      const peerMa = `/p2p-circuit/ipfs/${swarm._peerInfo.id.toB58String()}`
      if (addr.toString() !== peerMa) {
        listenAddrs.push(addr.encapsulate(`/ipfs/${swarm._peerInfo.id.toB58String()}`))
      } else {
        listenAddrs.push(peerMa) // by default we're reachable over any relay
      }
    })

    callback(null, listenAddrs)
  }

  return listener
}
