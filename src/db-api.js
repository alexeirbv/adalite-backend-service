// @flow

import type { Pool, ResultSet, Row } from 'pg'
import type { DbApi } from 'icarus-backend'; // eslint-disable-line

// helper function to avoid destructuring "".rows" in the codebase
const extractRows = (
  dbQuery: (...dbArgs: any) => Promise<ResultSet>,
) => async (...args: any): Promise<Array<Row>> => {
  const dbResult = await dbQuery(...args)
  return dbResult.rows
}

/**
 * Returns the list of addresses that were used at least once (as input or output)
 * @param {Db Object} db
 * @param {Array<Address>} addresses
 */
const filterUsedAddresses = (db: Pool) => async (
  addresses: Array<string>,
): Promise<ResultSet> =>
  db.query({
    text: 'SELECT DISTINCT address FROM tx_out WHERE address = ANY($1)',
    values: [addresses],
    rowMode: 'array',
  })

const unspentAddresses = (db: Pool) => async (): Promise<ResultSet> =>
  db.query({
    text: 'SELECT DISTINCT utxos.receiver FROM utxos',
    rowMode: 'array',
  })

const utxoQuery = `SELECT 
  TRIM(LEADING '\\x' from tx.hash::text) AS "tx_hash", tx_out.index AS "tx_index",
  tx_out.address AS "receiver", tx_out.value AS "amount", tx.block::INTEGER as "block_num"
FROM tx
INNER JOIN tx_out ON tx.id = tx_out.tx_id
WHERE NOT EXISTS (SELECT true
  FROM tx_in
  WHERE (tx_out.tx_id = tx_in.tx_out_id) AND (tx_out.index = tx_in.tx_out_index)
) AND (tx_out.address = ANY($1))`

/**
 * Queries UTXO table looking for unspents for given addresses
 *
 * @param {Db Object} db
 * @param {Array<Address>} addresses
 */
const utxoForAddresses = (db: Pool) => async (addresses: Array<string>) =>
  db.query({
    text: utxoQuery,
    values: [addresses],
  })

const utxoSumForAddresses = (db: Pool) => async (addresses: Array<string>) =>
  db.query(`SELECT SUM(amount) FROM (${utxoQuery}) as utxo_table`, [addresses])

const txHistoryQuery = (limit: number) => `
  SELECT txs.id, txs.hash, txs.block_no, txs.blockHash, txs.block_index as tx_ordinal, txs.time, tx_body.body::text from (
      SELECT
        tx.id, tx.hash::text, block.block_no, block.hash::text as blockHash, block.time, tx.block_index
        FROM block 
        INNER JOIN tx ON block.id = tx.block 
        INNER JOIN tx_out ON tx.id = tx_out.tx_id
        WHERE tx_out.address = ANY($1)
          AND block.time >= $2
    UNION
      SELECT DISTINCT 
        tx.id, tx.hash::text, block.block_no, block.hash::text as blockHash, block.time, tx.block_index
        FROM block 
        INNER JOIN tx ON block.id = tx.block 
        INNER JOIN tx_in ON tx.id = tx_in.tx_in_id 
        INNER JOIN tx_out ON (tx_in.tx_out_id = tx_out.tx_id) AND (tx_in.tx_out_index = tx_out.index)
        WHERE tx_out.address = ANY($1)
          AND block.time >= $2
    ORDER BY time ASC
    LIMIT ${limit}
  ) AS txs
  JOIN tx_body ON txs.hash = tx_body.hash::text
`

/**
 * Queries DB looking for transactions including (either inputs or outputs)
 * for the given addresses
 *
 * @param {Db Object} db
 * @param {Array<Address>} addresses
 */
const transactionsHistoryForAddresses = (db: Pool) => async (
  limit: number,
  addresses: Array<string>,
  dateFrom: Date,
): Promise<ResultSet> => db.query(txHistoryQuery(limit), [addresses, dateFrom])

// The remaining queries should be used only for the purposes of the legacy API!

/**
* Queries TXS table looking for a successful transaction with a given hash
* @param {Db Object} db
* @param {Transaction} tx
*/
const txSummary = (db: Pool) => async (tx: string): Promise<ResultSet> =>
  db.query({
    text: 'SELECT * FROM "txs" WHERE hash = $1 AND tx_state = $2',
    values: [tx, 'Successful'],
  })

/**
* Queries TX table looking for tx by its hash
* @param {Db Object} db
* @param {Transaction} tx
*/
const getTx = (db: Pool) => async (tx: string): Promise<ResultSet> =>
  db.query({
    text: 'SELECT id, block, hash::text FROM "tx" WHERE hash = $1',
    values: [tx],
  })

/**
* Queries TX_BODY table looking for tx body by its hash
* @param {Db Object} db
* @param {Transaction} tx
*/
const getRawTx = (db: Pool) => async (tx: string): Promise<ResultSet> =>
  db.query({
    text: 'SELECT body::text as tx_body FROM tx_body WHERE hash = $1',
    values: [tx],
  })

/**
* Queries BLOCK table looking for block with a given id
* @param {Db Object} db
* @param {Block} blockId
*/
const getBlockById = (db: Pool) => async (blockId: number): Promise<ResultSet> =>
  db.query({
    text: 'SELECT time, block_no, hash::text FROM block WHERE id = $1',
    values: [blockId],
  })

/**
* Queries TX* tables to get txInputs for a given transaction
* @param {Db Object} db
* @param {Transaction} tx
*/
const getSingleTxInputs = (db: Pool) => async (tx: number): Promise<ResultSet> =>
  db.query({
    text: `SELECT
      tx_out.address, tx_out.value
      FROM tx_out
      INNER JOIN tx ON tx.id = tx_out.tx_id
      INNER JOIN tx_in ON tx_in.tx_out_id = tx_out.tx_id AND tx_in.tx_out_index = tx_out.index
      WHERE tx_in.tx_in_id = $1`,
    values: [tx],
  })

/**
* Queries TX, BLOCK, TX_OUT tables to acquire inward and outward transactions for given addresses
* @param {Db Object} db
* @param {Array<Address>} addresses
*/
const getTransactions = (db: Pool) => async (addresses: Array<string>): Promise<ResultSet> =>
  db.query({
    text: `SELECT DISTINCT
      tx.id, tx.hash::text, block.time
      FROM block 
      INNER JOIN tx ON block.id = tx.block 
      INNER JOIN tx_out ON tx.id = tx_out.tx_id
      WHERE tx_out.address = ANY($1)
    UNION
    SELECT DISTINCT 
      tx.id, tx.hash::text, block.time
      FROM block 
      INNER JOIN tx ON block.id = tx.block 
      INNER JOIN tx_in ON tx.id = tx_in.tx_in_id 
      INNER JOIN tx_out ON (tx_in.tx_out_id = tx_out.tx_id) AND (tx_in.tx_out_index = tx_out.index)
      WHERE tx_out.address = ANY($1)`,
    values: [addresses],
  })

/**
* Queries TX* tables to acquire bulk tx inputs for given transactions
* @param {Db Object} db
* @param {Array<Transaction>} txIds
*/
const getTxsInputs = (db: Pool) => async (txIds: Array<number>): Promise<ResultSet> =>
  db.query({
    text: `SELECT DISTINCT
      tx.id as txId, tx_out.address, tx_out.value, tx2.hash::text, tx_out.index, (tx2.size = 0) 
      FROM tx
      INNER JOIN tx_in ON tx.id = tx_in.tx_in_id 
      INNER JOIN tx_out ON (tx_in.tx_out_id = tx_out.tx_id) AND (tx_in.tx_out_index = tx_out.index) 
      INNER JOIN tx AS tx2 ON tx2.id = tx_in.tx_out_id
      WHERE tx_in.tx_in_id = ANY($1)`,
    values: [txIds],
  })

/**
* Queries TX* tables to acquire bulk tx outputs for given transactions
* @param {Db Object} db
* @param {Array<Transaction>} txIds
*/
const getTxsOutputs = (db: Pool) => async (txIds: Array<number>): Promise<ResultSet> =>
  db.query({
    text: `SELECT
      tx.id as txId, tx_out.address, tx_out.value
      FROM tx 
      INNER JOIN tx_out ON tx.id = tx_out.tx_id
      WHERE tx.id = ANY($1)`,
    values: [txIds],
  })

/**
 * Queries UTXO table looking for unspents for given addresses and renames the columns
 * @param {Db Object} db
 * @param {Array<Address>} addresses
 */
const utxoLegacy = (db: Pool) => async (addresses: Array<string>): Promise<ResultSet> =>
  db.query({
    text: `SELECT 
      'CUtxo' AS "tag", tx.hash::text AS "cuId", tx_out.index AS "cuOutIndex", tx_out.address AS "cuAddress", tx_out.value AS "cuCoins"
      FROM tx
      INNER JOIN tx_out ON tx.id = tx_out.tx_id
      WHERE NOT EXISTS (SELECT true
        FROM tx_in
        WHERE (tx_out.tx_id = tx_in.tx_out_id) AND (tx_out.index = tx_in.tx_out_index)
      ) AND (tx_out.address = ANY($1))`,
    values: [addresses],
  })

const bestBlock = (db: Pool) => async (): Promise<number> => {
  const query = await db.query('SELECT block_no FROM block WHERE block_no IS NOT NULL ORDER BY block_no DESC LIMIT 1')
  return query.rows.length > 0 ? parseInt(query.rows[0].block_no, 10) : 0
}

export default (db: Pool): DbApi => ({
  filterUsedAddresses: filterUsedAddresses(db),
  unspentAddresses: unspentAddresses(db),
  utxoForAddresses: utxoForAddresses(db),
  utxoSumForAddresses: utxoSumForAddresses(db),
  transactionsHistoryForAddresses: extractRows(transactionsHistoryForAddresses(db)),
  bestBlock: bestBlock(db),
  // legacy
  txSummary: extractRows(txSummary(db)),
  utxoLegacy: extractRows(utxoLegacy(db)),
  // cardano-db-sync schema
  getTx: extractRows(getTx(db)),
  getRawTx: extractRows(getRawTx(db)),
  getBlockById: extractRows(getBlockById(db)),
  getSingleTxInputs: extractRows(getSingleTxInputs(db)),
  getTransactions: extractRows(getTransactions(db)),
  getTxsInputs: extractRows(getTxsInputs(db)),
  getTxsOutputs: extractRows(getTxsOutputs(db)),
})
