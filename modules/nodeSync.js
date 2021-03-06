/**
The nodeSync module,
checks the current node whether its synching or not and how much it kept up already.

@module nodeSync
*/

const _ = global._;
const Q = require('bluebird');
const EventEmitter = require('events').EventEmitter;
const { ipcMain: ipc } = require('electron');
const ethereumNode = require('./ethereumNode');
const log = require('./utils/logger').create('NodeSync');

const SYNC_CHECK_INTERVAL_MS = 2000;

class NodeSync extends EventEmitter {
  constructor() {
    super();

    ethereumNode.on('state', _.bind(this._onNodeStateChanged, this));
  }

  /**
   * @return {Promise}
   */
  start() {
    if (this._syncPromise) {
      log.warn('Sync already in progress, returning Promise');

      return Q.resolve(this._syncPromise);
    }

    this._syncPromise = Q.try(() => {
      if (!ethereumNode.isIpcConnected) {
        throw new Error('Cannot sync - Foicoin node not yet connected');
      }

      return new Q((resolve, reject) => {
        log.info('Starting sync loop');

        this._syncInProgress = true;
        this._onSyncDone = resolve;
        this._onSyncError = reject;

        this.emit('starting');

        ipc.on('backendAction_skipSync', () => {
          ipc.removeAllListeners('backendAction_skipSync');
          log.info('Sync has been skipped');

          this._onSyncDone();
        });

        this._sync();
      });
    })
      .then(() => {
        this.emit('finished');
      })
      .catch(err => {
        log.error('Sync error', err);

        this.emit('error', err);
      })
      .finally(() => {
        log.info('Sync loop ended');

        this._clearState();
      });

    return this._syncPromise;
  }

  /**
   * @return {Promise}
   */
  stop() {
    return Q.try(() => {
      if (!this._syncInProgress) {
        log.debug('Sync not already in progress.');
      } else {
        log.info('Stopping sync loop');

        this._clearState();

        return Q.delay(SYNC_CHECK_INTERVAL_MS).then(() => {
          this.emit('stopped');
        });
      }
    });
  }

  _clearState() {
    ipc.removeAllListeners('backendAction_skipSync');

    this._syncInProgress = this._syncPromise = this._onSyncDone = this._onSyncError = false;
  }

  _sync() {
    _.delay(() => {
      if (!this._syncInProgress) {
        log.debug('Sync no longer in progress, so ending sync loop.');

        return;
      }

      log.trace('Check sync status');

      ethereumNode
        .send('eth_syncing', [])
        .then(ret => {
          const result = ret.result;

          // got a result, check for error
          if (result) {
            log.trace('Sync status', result);

            // got an error?
            if (result.error) {
              if (result.error.code === -32601) {
                log.warn('Sync method not implemented, skipping sync.');

                return this._onSyncDone();
              }

              throw new Error(`Unexpected error: ${result.error}`);
            } else {
              // no error, so call again in a bit
              this.emit('nodeSyncing', result);

              return this._sync();
            }
          } else {
            // got no result, let's check the block number
            log.debug('Check latest block number');

            return ethereumNode
              .send('eth_getBlockByNumber', ['latest', false])
              .then(ret2 => {
                const blockResult = ret2.result;
                const now = Math.floor(new Date().getTime() / 1000);

                if (!blockResult) {
                  return this._sync();
                }

                log.debug(
                  `Last block: ${Number(blockResult.number)}; timestamp: ${
                    blockResult.timestamp
                  }`
                );

                const diff = now - +blockResult.timestamp;

                // need sync if > 1 minute
                if (diff > 60) {
                  this.emit('nodeSyncing', result);

                  log.trace('Keep syncing...');

                  return this._sync();
                }

                log.info('No more sync necessary');

                return this._onSyncDone();
              });
          }
        })
        .catch(err => {
          log.error('Node crashed while syncing?', err);

          this._onSyncError(err);
        });
    }, SYNC_CHECK_INTERVAL_MS);
  }

  _onNodeStateChanged(state) {
    switch (state) { // eslint-disable-line default-case
      // stop syncing when node about to be stopped
      case ethereumNode.STATES.STOPPING:
        log.info('Foicoin node stopping, so stop sync');

        this.stop();
        break;
      // auto-sync whenever node gets connected
      case ethereumNode.STATES.CONNECTED:
        log.info('Foicoin node connected, re-start sync');

        // stop syncing, then start again
        this.stop().then(() => {
          this.start();
        });
        break;
    }
  }
}

module.exports = new NodeSync();
