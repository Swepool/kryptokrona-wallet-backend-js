// Copyright (c) 2018, Zpalmtree
//
// Please see the included LICENSE file for more information.

import { IDaemon } from './IDaemon';
import { WalletSynchronizerJSON } from './JsonSerialization';
import { SubWallets } from './SubWallets';
import { SynchronizationStatus } from './SynchronizationStatus';

import {
    Block, KeyInput, RawCoinbaseTransaction, RawTransaction, Transaction,
    TransactionData,
} from './Types';

import * as _ from 'lodash';

export class WalletSynchronizer {

    public static fromJSON(json: WalletSynchronizerJSON): WalletSynchronizer {
        const walletSynchronizer = Object.create(WalletSynchronizer.prototype);

        return Object.assign(walletSynchronizer, json, {
            privateViewKey: json.privateViewKey,
            startHeight: json.startHeight,
            startTimestamp: json.startTimestamp,
            synchronizationStatus: SynchronizationStatus.fromJSON(json.transactionSynchronizerStatus),
        });
    }

    private daemon: IDaemon;

    private startTimestamp: number;

    private startHeight: number;

    private readonly privateViewKey: string;

    private synchronizationStatus: SynchronizationStatus = new SynchronizationStatus();

    /* Fuck the type system! */
    private subWallets: SubWallets = Object.create(SubWallets.prototype);

    constructor(
        daemon: IDaemon,
        startTimestamp: number,
        startHeight: number,
        privateViewKey: string) {

        this.daemon = daemon;
        this.startTimestamp = startTimestamp;
        this.startHeight = startHeight;
        this.privateViewKey = privateViewKey;
    }

    public initAfterLoad(subWallets: SubWallets): void {
        this.subWallets = subWallets;
    }

    public toJSON(): WalletSynchronizerJSON {
        return {
            privateViewKey: this.privateViewKey,
            startHeight: this.startHeight,
            startTimestamp: this.startTimestamp,
            transactionSynchronizerStatus: this.synchronizationStatus.toJSON(),
        };
    }

    public async getBlocks(): Promise<Block[]> {
        const localDaemonBlockCount: number = this.daemon.getLocalDaemonBlockCount();

        const walletBlockCount: number = this.synchronizationStatus.getHeight();

        /* Local daemon has less blocks than the wallet:

        With the get wallet sync data call, we give a height or a timestamp to
        start at, and an array of block hashes of the last known blocks we
        know about.

        If the daemon can find the hashes, it returns the next one it knows
        about, so if we give a start height of 200,000, and a hash of
        block 300,000, it will return block 300,001 and above.

        This works well, since if the chain forks at 300,000, it won't have the
        hash of 300,000, so it will return the next hash we gave it,
        in this case probably 299,999.

        On the wallet side, we'll detect a block lower than our last known
        block, and handle the fork.

        However, if we're syncing our wallet with an unsynced daemon,
        lets say our wallet is at height 600,000, and the daemon is at 300,000.
        If our start height was at 200,000, then since it won't have any block
        hashes around 600,000, it will start returning blocks from
        200,000 and up, discarding our current progress.

        Therefore, we should wait until the local daemon has more blocks than
        us to prevent discarding sync data. */
        if (localDaemonBlockCount < walletBlockCount) {
            return [];
        }

        /* The block hashes to try begin syncing from */
        const blockCheckpoints: string[] = this.synchronizationStatus.getBlockHashCheckpoints();

        let blocks: Block[] = [];

        try {
            blocks = await this.daemon.getWalletSyncData(
                blockCheckpoints, this.startHeight, this.startTimestamp,
            );
        } catch (err) {
            return [];
        }

        if (blocks.length === 0) {
            return [];
        }

        /* Timestamp is transient and can change - block height is constant. */
        if (this.startTimestamp !== 0) {
            this.startTimestamp = 0;
            this.startHeight = blocks[0].blockHeight;

            this.subWallets.convertSyncTimestampToHeight(
                this.startTimestamp, this.startHeight,
            );
        }

        /* If checkpoints are empty, this is the first sync request. */
        if (_.isEmpty(blockCheckpoints)) {
            const actualHeight: number = blocks[0].blockHeight;

            /* Only check if a timestamp isn't given */
            if (this.startTimestamp === 0) {
                /* The height we expect to get back from the daemon */
                if (actualHeight !== this.startHeight) {
                    throw new Error(
                        'Received unexpected block height from daemon. ' +
                        'Expected ' + this.startHeight + ', got ' + actualHeight + '\n',
                    );
                }
            }
        }

        return blocks;
    }

    public processTransactionInputs(
        keyInputs: KeyInput[],
        transfers: Map<string, number>,
        blockHeight: number,
        txData: TransactionData): [number, Map<string, number>, TransactionData] {

        let sumOfInputs: number = 0;

        for (const input of keyInputs) {
            sumOfInputs += input.amount;

            const [found, publicSpendKey] = this.subWallets.getKeyImageOwner(
                input.keyImage,
            );

            if (found) {
                let amount: number = transfers.get(publicSpendKey) || 0;
                amount += input.amount;

                transfers.set(publicSpendKey, amount);

                txData.keyImagesToMarkSpent.push([publicSpendKey, input.keyImage]);
            }
        }

        return [sumOfInputs, transfers, txData];
    }

    public processTransactionOutputs(
        rawTX: RawCoinbaseTransaction,
        transfers: Map<string, number>,
        blockHeight: number,
        txData: TransactionData): [number, Map<string, number>, TransactionData] {

        /* TODO */
        return [0, transfers, txData];
    }

    public processTransaction(
        rawTX: RawTransaction,
        blockTimestamp: number,
        blockHeight: number,
        txData: TransactionData): TransactionData {

        let transfers: Map<string, number> = new Map();

        let sumOfInputs: number;
        let sumOfOutputs: number;

        /* Finds the sum of inputs, adds the amounts that belong to us to the
           transfers map */
        [sumOfInputs, transfers, txData] = this.processTransactionInputs(
            rawTX.keyInputs, transfers, blockHeight, txData,
        );

        /* Finds the sum of outputs, adds the amounts that belong to us to the
           transfers map, and stores any key images that belong to us */
        [sumOfOutputs, transfers, txData] = this.processTransactionOutputs(
            rawTX, transfers, blockHeight, txData,
        );

        if (!_.isEmpty(transfers)) {
            const fee: number = sumOfInputs - sumOfOutputs;

            const isCoinbaseTransaction: boolean = false;

            const tx: Transaction = new Transaction(
                transfers, rawTX.hash, fee, blockTimestamp, blockHeight,
                rawTX.paymentID, rawTX.unlockTime, isCoinbaseTransaction,
            );

            txData.transactionsToAdd.push(tx);
        }

        return txData;
    }

    public processCoinbaseTransaction(
        rawTX: RawCoinbaseTransaction,
        blockTimestamp: number,
        blockHeight: number,
        txData: TransactionData): TransactionData {

        let transfers: Map<string, number> = new Map();

        [/*ignore*/, transfers, txData] = this.processTransactionOutputs(
            rawTX, transfers, blockHeight, txData,
        );

        if (!_.isEmpty(transfers)) {
            /* Coinbase transaction have no fee */
            const fee: number = 0;

            const isCoinbaseTransaction: boolean = true;

            /* Coibnase transactions can't have payment ID's */
            const paymentID: string = '';

            const tx: Transaction = new Transaction(
                transfers, rawTX.hash, fee, blockTimestamp, blockHeight,
                paymentID, rawTX.unlockTime, isCoinbaseTransaction,
            );

            txData.transactionsToAdd.push(tx);
        }

        return txData;
    }

    public getHeight(): number {
        return this.synchronizationStatus.getHeight();
    }

    public checkLockedTransactions(transactionHashes: string[]): string[] {
        /* TODO */
        return [];
    }

    public storeBlockHash(blockHeight: number, blockHash: string): void {
        this.synchronizationStatus.storeBlockHash(blockHeight, blockHash);
    }
}