// @flow

import { isValidAddress } from 'cardano-crypto.js'
import moment from 'moment'
import Big from 'big.js'
import { zip, nth } from 'lodash'

import type { ServerConfig } from 'icarus-backend'; // eslint-disable-line

const withPrefix = route => `/api${route}`
const invalidAddress = 'Invalid Cardano address!'
const invalidTx = 'Invalid transaction id!'

const arraySum = (numbers) => numbers.reduce((acc, val) => acc.plus(Big(val)), Big(0))

/**
 * Helper function that takes movements for various addresses and a set of addresses we are
 * interested in. The sum of movements for addresses we are interested in is returned.
*/
const txAddressCoins = (addresses, amounts, addressSet) => arraySum(zip(addresses, amounts)
  .filter((pair) => addressSet.has(pair[0]))
  .map((pair) => nth(pair, 1)))

const combinedBalance = (transactions, addresses) => {
  const addressSet = new Set(addresses)
  const totalIn = transactions.reduce((acc, tx) =>
    acc.plus(txAddressCoins(tx.outputs_address, tx.outputs_amount, addressSet)), Big(0))
  const totalOut = transactions.reduce((acc, tx) =>
    acc.plus(txAddressCoins(tx.inputs_address, tx.inputs_amount, addressSet)), Big(0))
  return totalIn.sub(totalOut)
}

const txToAddressInfo = (row) => ({
  ctbId: row.hash,
  ctbTimeIssued: moment(row.time).unix(),
  ctbInputs: row.inputs_address.map(
    (addr, i) => [addr, { getCoin: row.inputs_amount[i] }]),
  ctbOutputs: row.outputs_address.map(
    (addr, i) => [addr, { getCoin: row.outputs_amount[i] }]),
  ctbInputSum: {
    getCoin: `${arraySum(row.inputs_amount)}`,
  },
  ctbOutputSum: {
    getCoin: `${arraySum(row.outputs_amount)}`,
  },
})

/**
 * This endpoint returns a summary for a given address
 * @param {*} db Database
 * @param {*} Server Server Config Object
 */
const addressSummary = (dbApi: any, { logger }: ServerConfig) => async (req: any,
) => {
  const { address } = req.params
  if (!isValidAddress(address)) {
    return { Left: invalidAddress }
  }
  const result = await dbApi.bulkAddressSummary([address])
  const transactions = result.rows

  const right = {
    caAddress: address,
    caType: 'CPubKeyAddress',
    caTxNum: transactions.length,
    caBalance: {
      getCoin: `${combinedBalance(transactions, [address])}`,
    },
    caTxList: transactions.map(txToAddressInfo),
  }
  logger.debug('[addressSummary] result calculated')
  return { Right: right }
}

/**
 * This endpoint returns a transaction summary for a given hash
 * @param {*} db Database
 * @param {*} Server Server Config Object
 */
const txSummary = (dbApi: any, { logger }: ServerConfig) => async (req: any,
) => {
  const { tx } = req.params
  const getTxResult = await dbApi.getTx(`\\x${tx}`) // TODO/hrafn
  if (getTxResult.rows.length === 0) return { Left: invalidTx }

  const txRow = getTxResult.rows[0]
  const getBlockResult = await dbApi.getBlockById(txRow.block)
  const blockRow = getBlockResult.rows[0]

  const inputsResult = await dbApi.getTxInputs(txRow.id)
  const outputsResult = await dbApi.getTxOutputs(txRow.id)

  const inputs = inputsResult.rows
  const outputs = outputsResult.rows

  const totalInput = arraySum(inputs.map(elem => elem.value))
  const totalOutput = arraySum(outputs.map(elem => elem.value))
  const epoch0 = 1506203091
  const slotSeconds = 20
  const epochSlots = 21600
  const blockTime = moment(blockRow.time).unix()
  const right = {
    ctsId: txRow.hash.toString('hex'),
    ctsTxTimeIssued: blockTime,
    ctsBlockTimeIssued: blockTime,
    ctsBlockHeight: Number(blockRow.block_no),
    ctsBlockEpoch: Math.floor((blockTime - epoch0) / (epochSlots * slotSeconds)),
    ctsBlockSlot: Math.floor((blockTime - epoch0) / slotSeconds) % epochSlots,
    ctsBlockHash: blockRow.hash.toString('hex'),
    ctsRelayedBy: null,
    ctsTotalInput: {
      getCoin: `${totalInput}`,
    },
    ctsTotalOutput: {
      getCoin: `${totalOutput}`,
    },
    ctsFees: {
      getCoin: `${totalInput.sub(totalOutput)}`,
    },
    ctsInputs: inputs.map(
      input => [input.address, { getCoin: input.value }]),
    ctsOutputs: outputs.map(
      output => [output.address, { getCoin: output.value }]),
  }
  logger.debug('[txSummary] result calculated')
  return { Right: right }
}

/**
 * This endpoint returns a raw transaction body for a given hash
 * @param {*} db Database
 * @param {*} Server Server Config Object
 */
const txRaw = (dbApi: any, { logger }: ServerConfig) => async (req: any,
) => {
  const { tx } = req.params
  const result = await dbApi.txSummary(tx)
  if (result.rows.length === 0) {
    return { Left: invalidTx }
  }
  logger.debug('[txRaw] result calculated')
  return { Right: result.rows[0].tx_body }
}

/**
 * This endpoint returns unspent transaction outputs for a given array of addresses
 * @param {*} db Database
 * @param {*} Server Server Config Object
 */
const unspentTxOutputs = (dbApi: any, { logger, apiConfig }: ServerConfig) => async (req: any,
) => {
  const addresses = req.body
  const limit = apiConfig.addressesRequestLimit
  if (!addresses || addresses.length === 0 || addresses.length > limit) {
    return { Left: `Addresses request length should be (0, ${limit}]` }
  }
  if (addresses.some((addr) => !isValidAddress(addr))) {
    return { Left: invalidAddress }
  }
  const result = await dbApi.utxoLegacy(addresses)
  const mappedRows = result.rows.map((row) => {
    const coins = row.cuCoins
    const newRow = row
    newRow.cuCoins = { getCoin: coins }
    return newRow
  })
  logger.debug('[unspentTxOutputs] result calculated')
  return { Right: mappedRows }
}

/**
 * This endpoint returns the list of addresses, the number of their transactions and the list of
 * transactions.
 * @param {*} db Database
 * @param {*} Server Server Config Object
 */
const bulkAddressSummary = (dbApi: any, { logger, apiConfig }: ServerConfig) => async (req: any,
) => {
  const addresses = req.body
  const limit = apiConfig.addressesRequestLimit
  if (!addresses || addresses.length === 0 || addresses.length > limit) {
    return { Left: `Addresses request length should be (0, ${limit}]` }
  }
  if (addresses.some((addr) => !isValidAddress(addr))) {
    return { Left: invalidAddress }
  }
  const txList = await dbApi.bulkAddressSummary(addresses)
  const transactions = txList.rows

  const right = {
    caAddresses: addresses,
    caTxNum: transactions.length,
    caBalance: {
      getCoin: `${combinedBalance(transactions, addresses)}`,
    },
    caTxList: transactions.map(txToAddressInfo),
  }
  logger.debug('[bulkAddressSummary] result calculated')
  return { Right: right }
}

export default {
  addressSummary: {
    method: 'get',
    path: withPrefix('/addresses/summary/:address'),
    handler: addressSummary,
  },
  txSummary: {
    method: 'get',
    path: withPrefix('/txs/summary/:tx'),
    handler: txSummary,
  },
  txRaw: {
    method: 'get',
    path: withPrefix('/txs/raw/:tx'),
    handler: txRaw,
  },
  unspentTxOutputs: {
    method: 'post',
    path: withPrefix('/bulk/addresses/utxo'),
    handler: unspentTxOutputs,
  },
  bulkAddressSummary: {
    method: 'post',
    path: withPrefix('/bulk/addresses/summary'),
    handler: bulkAddressSummary,
  },
}
