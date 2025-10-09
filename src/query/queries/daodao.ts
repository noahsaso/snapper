import { Coin } from '@cosmjs/stargate'
import { ChainId } from '@dao-dao/types'
import { DecCoin } from '@dao-dao/types/protobuf/codegen/cosmos/base/v1beta1/coin'
import { UnbondingDelegation } from '@dao-dao/types/protobuf/codegen/cosmos/staking/v1beta1/staking'
import {
  ContractName,
  DAO_CORE_CONTRACT_NAMES,
  INVALID_CONTRACT_ERROR_SUBSTRINGS,
  POLYTONE_CONFIG_PER_CHAIN,
  decodeJsonFromBase64,
  encodeJsonToBase64,
  getChainForChainId,
  maybeGetChainForChainId,
  polytoneNoteProxyMapToChainIdMap,
} from '@dao-dao/utils'
import uniq from 'lodash.uniq'
import MeiliSearch from 'meilisearch'

import { DAODAO_MEILISEARCH_API_KEY, DAODAO_MEILISEARCH_HOST } from '@/config'
import { Query, QueryType } from '@/types'
import {
  TimeRange,
  deserializeSkipAssetOrigin,
  findValueAtTimestamp,
  getRangeBounds,
  isValidTimeRange,
  serializeSkipAssetOrigin,
} from '@/utils'

import { coingeckoPriceHistoryQuery } from './coingecko'
import { icaRemoteAddressQuery } from './ibc'
import {
  cosmosBalancesQuery,
  cosmosClaimableRewardsQuery,
  cosmosCommunityPoolBalancesQuery,
  cosmosContractStateKeyQuery,
  cosmosIsIcaQuery,
  cosmosStakedBalanceQuery,
  cosmosUnstakingBalanceQuery,
} from './rpc'
import { SkipAsset, skipAssetQuery } from './skip'
import { stargazeUsdValueQuery } from './stargaze'
import { tokenPriceQuery } from './token'

/**
 * The address passed to the query to indicate that it should load tokens from
 * the community pool instead.
 */
const COMMUNITY_POOL_ADDRESS_PLACEHOLDER = 'COMMUNITY_POOL'

const getIndexerUrl = (chainId: string) => {
  return `https://indexer.daodao.zone/${chainId}`
}

export const daodaoBankBalancesHistoryQuery: Query<
  | {
      // Map of denom to balance.
      value: Record<string, string | undefined>
      blockHeight: number
      blockTimeUnixMs: number
    }[]
  | undefined,
  {
    chainId: string
    address: string
    range: TimeRange
    // Optionally specify an end timestamp.
    end?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-bank-balances-history',
  parameters: ['chainId', 'address', 'range'],
  optionalParameters: ['end'],
  validate: ({ range, end }) =>
    isValidTimeRange(range) &&
    (!end || (!isNaN(Number(end)) && Number(end) > 0)),
  url: ({ chainId, address, range, end: endTime }) => {
    const { start, end, interval } = getRangeBounds(
      range,
      endTime ? new Date(Number(endTime)) : undefined
    )

    return `${getIndexerUrl(chainId)}/wallet/${address}/bank/balances?times=${BigInt(start * 1000).toString()}..${BigInt(end * 1000).toString()}&timeStep=${BigInt(interval * 1000).toString()}`
  },
  // Cache for:
  // - 1 minute when querying the past hour
  // - 1 hour when querying the past day
  // - 1 day when querying the rest
  ttl: ({ range }) =>
    range === TimeRange.Hour
      ? 60
      : range === TimeRange.Day
        ? 60 * 60
        : 24 * 60 * 60,
}

export const daodaoCw20BalancesQuery: Query<
  // List of contract addresses and balances.
  { contractAddress: string; balance: string }[],
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-cw20-balances',
  parameters: ['chainId', 'address'],
  url: ({ chainId, address }) =>
    `${getIndexerUrl(chainId)}/wallet/${address}/tokens/list`,
  ttl: 60,
}

export const daodaoCw20BalancesHistoryQuery: Query<
  | {
      // List of contract addresses and balances.
      value: { contractAddress: string; balance: string }[]
      blockHeight: number
      blockTimeUnixMs: number
    }[]
  | undefined,
  {
    chainId: string
    address: string
    range: TimeRange
    // Optionally specify an end timestamp.
    end?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-cw20-balances-history',
  parameters: ['chainId', 'address', 'range'],
  optionalParameters: ['end'],
  validate: ({ range, end }) =>
    isValidTimeRange(range) &&
    (!end || (!isNaN(Number(end)) && Number(end) > 0)),
  url: ({ chainId, address, range, end: endTime }) => {
    const { start, end, interval } = getRangeBounds(
      range,
      endTime ? new Date(Number(endTime)) : undefined
    )

    return `${getIndexerUrl(chainId)}/wallet/${address}/tokens/list?times=${BigInt(start * 1000).toString()}..${BigInt(end * 1000).toString()}&timeStep=${BigInt(interval * 1000).toString()}`
  },
  // Cache for:
  // - 1 minute when querying the past hour
  // - 1 hour when querying the past day
  // - 1 day when querying the rest
  ttl: ({ range }) =>
    range === TimeRange.Hour
      ? 60
      : range === TimeRange.Day
        ? 60 * 60
        : 24 * 60 * 60,
}

// export const daodaoCommunityPoolQuery: Query<
//   // Map of denom to balance.
//   Record<string, string | undefined>,
//   {
//     chainId: string
//   }
// > = {
//   type: QueryType.Url,
//   name: 'daodao-community-pool',
//   parameters: ['chainId'],
//   url: ({ chainId }) =>
//     `${getIndexerUrl(chainId)}/generic/_/communityPool/balances`,
//   ttl: 60,
// }

export const daodaoCommunityPoolHistoryQuery: Query<
  | {
      // Map of denom to balance.
      value: Record<string, string | undefined>
      blockHeight: number
      blockTimeUnixMs: number
    }[]
  | undefined,
  {
    chainId: string
    range: TimeRange
    // Optionally specify an end timestamp.
    end?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-community-pool-history',
  parameters: ['chainId', 'range'],
  optionalParameters: ['end'],
  validate: ({ range, end }) =>
    isValidTimeRange(range) &&
    (!end || (!isNaN(Number(end)) && Number(end) > 0)),
  url: ({ chainId, range, end: endTime }) => {
    const { start, end, interval } = getRangeBounds(
      range,
      endTime ? new Date(Number(endTime)) : undefined
    )

    return `${getIndexerUrl(chainId)}/generic/_/communityPool/balances?times=${BigInt(start * 1000).toString()}..${BigInt(end * 1000).toString()}&timeStep=${BigInt(interval * 1000).toString()}`
  },
  // Cache for:
  // - 1 minute when querying the past hour
  // - 1 hour when querying the past day
  // - 1 day when querying the rest
  ttl: ({ range }) =>
    range === TimeRange.Hour
      ? 60
      : range === TimeRange.Day
        ? 60 * 60
        : 24 * 60 * 60,
}

type AssetWithValue = {
  asset: SkipAsset
  unstakedBalance: string
  stakedBalance: string
  unstakingBalance: string
  claimableRewards: string
  price: number
  value: number
}

type PortfolioValue = {
  assets: AssetWithValue[]
  stargazeNfts: number
  totalValue: number
}

export const daodaoValueQuery: Query<
  PortfolioValue,
  {
    chainId: string
    address: string
    // Optionally filter by token denom/address. Comma separated.
    tokenFilter?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-value',
  parameters: ['chainId', 'address'],
  optionalParameters: ['tokenFilter'],
  execute: async ({ chainId, address, tokenFilter: _tokenFilter }, query) => {
    const tokenFilter = _tokenFilter?.split(',')
    const isCommunityPool = address === COMMUNITY_POOL_ADDRESS_PLACEHOLDER

    // Check if the chain is indexed.
    // const communityPoolIsIndexed =
    //   isCommunityPool &&
    //   (
    //     await query(daodaoChainIsIndexedQuery, {
    //       chainId,
    //     })
    //   ).body
    // Not indexing this for any chains right now.
    const communityPoolIsIndexed = false

    let communityPoolBody: Record<string, string | undefined>
    let nativeUnstakedBody: readonly Coin[]
    let nativeStakedBody: Coin | null
    let nativeUnstakingBody: UnbondingDelegation[]
    let nativeClaimableRewardsBody: DecCoin[]
    let cw20Body: {
      contractAddress: string
      balance: string
    }[]
    try {
      const [
        // communityPoolIndexedBodyPromise,
        communityPoolNotIndexedBodyPromise,
        nativeBodyPromisesPromise,
        cw20BodyPromise,
      ] = await Promise.allSettled([
        // isCommunityPool && communityPoolIsIndexed
        //   ? query(daodaoCommunityPoolQuery, {
        //       chainId,
        //     })
        //   : { body: {} as Record<string, string | undefined> },
        isCommunityPool && !communityPoolIsIndexed
          ? query(cosmosCommunityPoolBalancesQuery, {
              chainId,
            })
          : { body: [] as DecCoin[] },
        !isCommunityPool
          ? // Not all chains have staking, so allow these to fail.
            Promise.allSettled([
              query(cosmosBalancesQuery, {
                chainId,
                address,
              }),
              query(cosmosStakedBalanceQuery, {
                chainId,
                address,
              }),
              query(cosmosUnstakingBalanceQuery, {
                chainId,
                address,
              }),
              query(cosmosClaimableRewardsQuery, {
                chainId,
                address,
              }),
            ])
          : null,
        query(daodaoCw20BalancesQuery, {
          chainId,
          address,
        }),
      ])

      const nativeBodyPromises =
        nativeBodyPromisesPromise.status === 'fulfilled'
          ? nativeBodyPromisesPromise.value
          : null

      communityPoolBody =
        communityPoolIsIndexed &&
        /* communityPoolIndexedBodyPromise.status === 'fulfilled'
          ? communityPoolIndexedBodyPromise.value.body
          : !communityPoolIsIndexed && */
        communityPoolNotIndexedBodyPromise.status === 'fulfilled'
          ? Object.fromEntries(
              communityPoolNotIndexedBodyPromise.value.body.map(
                ({ denom, amount }) => [denom, amount]
              )
            )
          : {}
      nativeUnstakedBody =
        nativeBodyPromises?.[0].status === 'fulfilled'
          ? nativeBodyPromises[0].value.body
          : []
      nativeStakedBody =
        nativeBodyPromises?.[1].status === 'fulfilled'
          ? nativeBodyPromises[1].value.body
          : null
      nativeUnstakingBody =
        nativeBodyPromises?.[2].status === 'fulfilled'
          ? nativeBodyPromises[2].value.body
          : []
      nativeClaimableRewardsBody =
        nativeBodyPromises?.[3].status === 'fulfilled'
          ? nativeBodyPromises[3].value.body
          : []
      cw20Body =
        cw20BodyPromise.status === 'fulfilled' ? cw20BodyPromise.value.body : []
    } catch (err) {
      if (err instanceof Error && err.message.includes('Invalid chain ID')) {
        throw new Error('Unsupported chain for value query')
      }

      throw err
    }

    const uniqueAssets = uniq([
      ...Object.keys(communityPoolBody).filter(
        (denom) => !tokenFilter || tokenFilter.includes(denom)
      ),
      ...[
        ...nativeUnstakedBody,
        ...nativeClaimableRewardsBody,
        ...(nativeStakedBody ? [nativeStakedBody] : []),
      ].flatMap(({ denom }) =>
        !tokenFilter || tokenFilter.includes(denom) ? denom : []
      ),
      ...cw20Body
        .map(({ contractAddress }) => contractAddress)
        .filter(
          (contractAddress) =>
            !tokenFilter || tokenFilter.includes(contractAddress)
        )
        .map((contractAddress) => `cw20:${contractAddress}`),
    ])

    const assets = (
      await Promise.all(
        uniqueAssets.map(async (denom) => {
          const cw20 = denom.startsWith('cw20:')
          denom = cw20 ? denom.slice(5) : denom

          const { body: asset } = await query(skipAssetQuery, {
            chainId,
            denom,
            cw20: cw20.toString(),
          })
          if (!asset?.decimals) {
            return
          }

          let price: number
          try {
            const priceResponse = await query(tokenPriceQuery, {
              chainId,
              denom,
              cw20: cw20.toString(),
            })
            price = priceResponse.body
            if (typeof price !== 'number') {
              return
            }
          } catch {
            return
          }

          const unstakedBalance =
            (cw20
              ? cw20Body.find(
                  ({ contractAddress }) => contractAddress === denom
                )?.balance
              : isCommunityPool
                ? communityPoolBody[denom]
                : nativeUnstakedBody.find((coin) => coin.denom === denom)
                    ?.amount) || '0'
          const stakedBalance =
            !cw20 && !isCommunityPool && denom === nativeStakedBody?.denom
              ? nativeStakedBody.amount
              : '0'
          const unstakingBalance =
            !cw20 && !isCommunityPool && denom === nativeStakedBody?.denom
              ? nativeUnstakingBody
                  .reduce(
                    (acc, { entries }) =>
                      acc +
                      entries.reduce(
                        (acc2, { balance }) => acc2 + BigInt(balance),
                        0n
                      ),
                    0n
                  )
                  .toString()
              : '0'
          const claimableRewards =
            (!cw20 &&
              !isCommunityPool &&
              nativeClaimableRewardsBody.find((coin) => coin.denom === denom)
                ?.amount) ||
            '0'

          return {
            asset,
            unstakedBalance,
            stakedBalance,
            unstakingBalance,
            claimableRewards,
            price,
            value:
              price *
              ((Number(unstakedBalance) +
                Number(stakedBalance) +
                Number(unstakingBalance) +
                Number(claimableRewards)) /
                Math.pow(10, asset.decimals)),
          }
        })
      )
    )
      .flatMap((data) => data || [])
      .sort((a, b) => b.value - a.value)

    const stargazeNfts =
      chainId === ChainId.StargazeMainnet || chainId === ChainId.StargazeTestnet
        ? (
            await query(stargazeUsdValueQuery, {
              chainId,
              address,
            })
          ).body
        : 0

    const assetValue = assets.reduce((acc, { value }) => acc + (value || 0), 0)
    const totalValue = assetValue + stargazeNfts

    return {
      assets,
      stargazeNfts,
      totalValue,
    }
  },
  ttl: 60,
}

export const daodaoValueHistoryQuery: Query<
  {
    assets: SkipAsset[]
    snapshots: {
      timestamp: number
      values: {
        price?: number
        balance?: string
        value?: number
      }[]
      totalValue: number
    }[]
  },
  {
    chainId: string
    address: string
    range: TimeRange
    // Optionally filter by token denom/address. Comma separated.
    tokenFilter?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-value-history',
  parameters: ['chainId', 'address', 'range'],
  optionalParameters: ['tokenFilter'],
  validate: ({ range }) => isValidTimeRange(range),
  execute: async (
    { chainId, address, range, tokenFilter: _tokenFilter },
    query
  ) => {
    const tokenFilter = _tokenFilter?.split(',')
    const end = Date.now().toString()
    const isCommunityPool = address === COMMUNITY_POOL_ADDRESS_PLACEHOLDER

    let nativeSnapshots: {
      value: Record<string, string | undefined>
      blockHeight: number
      blockTimeUnixMs: number
    }[]
    let cw20Snapshots: {
      value: {
        contractAddress: string
        balance: string
      }[]
      blockHeight: number
      blockTimeUnixMs: number
    }[]

    try {
      const [{ body: nativeBody }, { body: cw20Body }] = await Promise.all([
        isCommunityPool
          ? query(daodaoCommunityPoolHistoryQuery, {
              chainId,
              range,
              end,
            })
          : query(daodaoBankBalancesHistoryQuery, {
              chainId,
              address,
              range,
              end,
            }),
        query(daodaoCw20BalancesHistoryQuery, {
          chainId,
          address,
          range,
          end,
        }),
      ])

      nativeSnapshots = nativeBody || []
      cw20Snapshots = cw20Body || []
    } catch (err) {
      if (err instanceof Error && err.message.includes('Invalid chain ID')) {
        throw new Error('Unsupported chain for value history query')
      }

      throw err
    }

    const uniqueAssets = uniq([
      ...nativeSnapshots
        .flatMap(({ value }) => Object.keys(value))
        .filter((denom) => !tokenFilter || tokenFilter.includes(denom)),
      ...cw20Snapshots
        .flatMap(({ value }) =>
          value.map(({ contractAddress }) => contractAddress)
        )
        .filter(
          (contractAddress) =>
            !tokenFilter || tokenFilter.includes(contractAddress)
        )
        .map((contractAddress) => `cw20:${contractAddress}`),
    ]).filter(Boolean)

    const assets = (
      await Promise.all(
        uniqueAssets.map(async (denom) => {
          const cw20 = denom.startsWith('cw20:')
          denom = cw20 ? denom.slice(5) : denom

          const { body: asset } = await query(skipAssetQuery, {
            chainId,
            denom,
            cw20: cw20.toString(),
          })
          if (!asset?.coingecko_id || !asset.decimals) {
            return
          }

          const { body: prices } = await query(coingeckoPriceHistoryQuery, {
            id: asset.coingecko_id,
            range,
            end,
          })

          const balances = cw20
            ? cw20Snapshots.flatMap(({ value, blockTimeUnixMs }) => {
                const balance = value.find(
                  ({ contractAddress }) => contractAddress === denom
                )?.balance

                return balance
                  ? {
                      timestamp: blockTimeUnixMs,
                      balance,
                    }
                  : []
              })
            : nativeSnapshots.flatMap(({ value, blockTimeUnixMs }) => {
                const balance = value[denom]
                return balance
                  ? {
                      timestamp: blockTimeUnixMs,
                      balance,
                    }
                  : []
              })

          return prices.length && balances.length
            ? {
                denom,
                asset,
                prices: prices.map(([timestamp, price]) => ({
                  timestamp,
                  price,
                })),
                balances,
              }
            : undefined
        })
      )
    ).flatMap((data) => data || [])

    if (!assets.length) {
      return {
        assets: [],
        snapshots: [],
      }
    }

    // All prices have similar timestamps since they use the same range (though
    // they may have been cached at different times), so choose the one with the
    // most timestamps available.
    const assetWithMostPrices = assets.reduce((acc, asset) =>
      asset.prices.length > acc.prices.length ? asset : acc
    )
    // Chop off the first two timestamps. Even though we fetch the same range
    // for each asset, they tend to start/end at slightly different times,
    // meaning we can't guarantee that we know the price of every asset at any
    // of their first timestamps. Since they all use the same range, the
    // interval should remain constant. Thus each asset's second timestamp
    // should be after all of the first timestamps for each asset and be safe to
    // use. To be extra safe, chop off the first two timestamps. Also the price
    // history queries add some buffer at the beginning to account for this.
    const timestamps =
      assetWithMostPrices?.prices.map(({ timestamp }) => timestamp).slice(2) ||
      []

    const snapshots = timestamps.flatMap((timestamp) => {
      // Order of values in each snapshot matches order of assets.
      const values = assets.map(({ asset, balances, prices }) => {
        const balance = findValueAtTimestamp(balances, timestamp)?.balance
        const price = findValueAtTimestamp(prices, timestamp)?.price
        const value =
          balance && price !== undefined && asset.decimals
            ? price * (Number(balance) / Math.pow(10, asset.decimals))
            : undefined

        return { price, balance, value }
      })

      // Ignore snapshots with no values.
      if (!values.some(({ value }) => value !== undefined)) {
        return []
      }

      const totalValue = values.reduce(
        (acc, { value }) => acc + (value || 0),
        0
      )

      return {
        timestamp,
        values,
        totalValue,
      }
    })

    return {
      assets: assets.map(({ asset }) => asset),
      snapshots,
    }
  },
  // Cache for:
  // - 5 minutes when querying the past hour
  // - 1 hour when querying the past day
  // - 1 day when querying the rest
  ttl: ({ range }) =>
    range === TimeRange.Hour
      ? 5 * 60
      : range === TimeRange.Day
        ? 60 * 60
        : 24 * 60 * 60,
}

type AccountWithPortfolioValue = {
  // Used in daodaoTvlQuery.
  type?: string
  chainId: string
  address: string
} & PortfolioValue

export type ManyValueResponse = {
  accounts: AccountWithPortfolioValue[]
  assets: {
    origin: {
      chainId: string
      denom: string
    }
    value: number
  }[]
  total: number
}

export const daodaoManyValueQuery: Query<
  ManyValueResponse,
  {
    // Comma-separated list of <chainId>:<address>
    accounts: string
    // Optionally filter by tokens. Comma-separated list of
    // <chainId>:<denomOrAddress>.
    tokenFilter?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-many-value',
  parameters: ['accounts'],
  optionalParameters: ['tokenFilter'],
  validate: ({ accounts }) =>
    accounts.split(',').every((account) => account.includes(':')),
  execute: async (
    { accounts: _accounts, tokenFilter: _tokenFilter },
    query
  ) => {
    // Group by chain ID.
    const tokenFilter =
      _tokenFilter?.split(',').reduce(
        (acc, filter) => {
          const [chainId, denomOrAddress] = filter.split(':')
          return {
            ...acc,
            [chainId]: [...(acc[chainId] || []), denomOrAddress],
          }
        },
        {} as Record<string, string[]>
      ) || {}

    const accounts = await Promise.all(
      _accounts
        .split(',')
        .map(async (account): Promise<AccountWithPortfolioValue> => {
          const [chainId, address] = account.split(':')
          try {
            return {
              chainId,
              address,
              ...(
                await query(daodaoValueQuery, {
                  chainId,
                  address,
                  tokenFilter: tokenFilter[chainId]?.join(','),
                })
              ).body,
            }
          } catch (err) {
            // If the account is on a chain that is unsupported, ignore.
            if (err instanceof Error && err.message.includes('Unsupported')) {
              return {
                chainId,
                address,
                assets: [],
                stargazeNfts: 0,
                totalValue: 0,
              }
            }

            throw err
          }
        })
    )

    if (!accounts.length) {
      return {
        accounts: [],
        assets: [],
        total: 0,
      }
    }

    // Get unique tokens across all accounts.
    const uniqueAssetOrigins = uniq(
      accounts.flatMap(({ assets }) =>
        assets.map(({ asset }) => serializeSkipAssetOrigin(asset))
      )
    )

    const assets = uniqueAssetOrigins
      .map((assetOrigin) => {
        // Get the value of this asset for each account.
        const accountAssetValues = accounts
          .map(
            ({ assets }) =>
              assets.find(
                ({ asset }) => serializeSkipAssetOrigin(asset) === assetOrigin
              )?.value
          )
          .flatMap((v) => (v ? [v] : []))

        // Sum account values.
        const value = accountAssetValues.reduce((acc, v) => acc + v, 0)

        return {
          origin: deserializeSkipAssetOrigin(assetOrigin),
          value,
        }
      })
      .sort((a, b) => b.value - a.value)

    const total = accounts
      .map(({ totalValue }) => totalValue)
      .reduce((acc, v) => acc + v, 0)

    return {
      accounts,
      assets,
      total,
    }
  },
  ttl: 60,
}

export const daodaoManyValueHistoryQuery: Query<
  {
    timestamps: number[]
    assets: {
      origin: {
        chainId: string
        denom: string
      }
      // Value at each timestamp.
      values: (number | null)[]
    }[]
    // Total value at each timestamp.
    totals: (number | null)[]
  },
  {
    // Comma-separated list of <chainId>:<address>
    accounts: string
    range: TimeRange
    // Optionally filter by tokens. Comma-separated list of
    // <chainId>:<denomOrAddress>.
    tokenFilter?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-many-value-history',
  parameters: ['accounts', 'range'],
  optionalParameters: ['tokenFilter'],
  validate: ({ accounts, range }) =>
    accounts.split(',').every((account) => account.includes(':')) &&
    isValidTimeRange(range),
  execute: async ({ accounts, range, tokenFilter: _tokenFilter }, query) => {
    // Group by chain ID.
    const tokenFilter = _tokenFilter?.split(',').reduce(
      (acc, filter) => {
        const [chainId, denomOrAddress] = filter.split(':')
        return {
          ...acc,
          [chainId]: [...(acc[chainId] || []), denomOrAddress],
        }
      },
      {} as Record<string, string[]>
    )

    const accountHistories = await Promise.all(
      accounts.split(',').map(async (account) => {
        const [chainId, address] = account.split(':')
        try {
          return (
            await query(daodaoValueHistoryQuery, {
              chainId,
              address,
              range,
              tokenFilter: tokenFilter?.[chainId].join(','),
            })
          ).body
        } catch (err) {
          // If the account is on a chain that is unsupported, ignore.
          if (err instanceof Error && err.message.includes('Unsupported')) {
            return {
              assets: [],
              snapshots: [],
            }
          }

          throw err
        }
      })
    )

    if (!accountHistories.length) {
      return {
        timestamps: [],
        assets: [],
        totals: [],
      }
    }

    // All queries have similar timestamps since they use the same range
    // (though they may have been cached at different times), so choose the
    // one with the most timestamps available.
    const oldestAccount = accountHistories.reduce((acc, account) =>
      account.snapshots.length > acc.snapshots.length ? account : acc
    )
    let timestamps =
      oldestAccount?.snapshots.map(({ timestamp }) => timestamp) || []

    // Get unique tokens across all accounts.
    const uniqueAssetOrigins = uniq(
      accountHistories.flatMap(({ assets }) =>
        assets.map(serializeSkipAssetOrigin)
      )
    )

    const assets = uniqueAssetOrigins.map((assetOrigin) => {
      // Get the snapshots of this token at each timestamp for each account.
      const accountTokenSnapshots = accountHistories.map(
        ({ assets, snapshots }) => {
          // Get the index of this asset in the snapshots for this account's
          // historical balances.
          const snapshotAssetIndex = assets.findIndex(
            (asset) => serializeSkipAssetOrigin(asset) === assetOrigin
          )

          if (snapshotAssetIndex === -1) {
            return []
          }

          // Extract this token's value at each timestamp.
          return snapshots.map(({ timestamp, values }) => ({
            timestamp,
            value: values[snapshotAssetIndex].value,
          }))
        }
      )

      const values = timestamps.map((timestamp) => {
        // Get the account values at this timestamp for each account.
        const accountValues = accountTokenSnapshots.map(
          (snapshots) => findValueAtTimestamp(snapshots, timestamp)?.value
        )

        // Sum the values at this timestamp. If all are undefined, return null
        // to indicate there's no data for this timestamp.
        return accountValues.reduce(
          (acc, value) =>
            acc === null && value === undefined
              ? null
              : (acc || 0) + (value || 0),
          null as number | null
        )
      })

      return {
        origin: deserializeSkipAssetOrigin(assetOrigin),
        values,
      }
    })

    // Sum up the values at each timestamp, ignoring null values.
    let totals = timestamps.map((_, index) =>
      assets.reduce((acc, { values }) => acc + (values[index] || 0), 0)
    )

    // Remove timestamps at the front that have no data for all tokens.

    // Get first timestamp with a value.
    let firstNonNullTimestamp = timestamps.findIndex((_, index) =>
      assets.some(({ values }) => values[index] !== null)
    )

    // If no non-null timestamps, remove all.
    if (firstNonNullTimestamp === -1) {
      firstNonNullTimestamp = totals.length
    }

    if (firstNonNullTimestamp > 0) {
      timestamps = timestamps.slice(firstNonNullTimestamp)
      assets.forEach(
        (data) => (data.values = data.values.slice(firstNonNullTimestamp))
      )
      totals = totals.slice(firstNonNullTimestamp)
    }

    return {
      timestamps,
      assets,
      totals,
    }
  },
  // Cache for:
  // - 5 minutes when querying the past hour
  // - 1 hour when querying the past day
  // - 1 day when querying the rest
  ttl: ({ range }) =>
    range === TimeRange.Hour
      ? 5 * 60
      : range === TimeRange.Day
        ? 60 * 60
        : 24 * 60 * 60,
}

export const daodaoListItemsQuery: Query<
  // List of key and value.
  [string, string][],
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-list-items',
  parameters: ['chainId', 'address'],
  url: ({ chainId, address }) =>
    `${getIndexerUrl(chainId)}/contract/${address}/daoCore/listItems`,
  ttl: 30,
}

export const daodaoListItemsWithPrefixQuery: Query<
  // List of key and value, where key has the prefix removed.
  [string, string][],
  {
    chainId: string
    address: string
    prefix: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-list-items-with-prefix',
  parameters: ['chainId', 'address', 'prefix'],
  execute: async ({ chainId, address, prefix }, query) =>
    (await query(daodaoListItemsQuery, { chainId, address })).body
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  ttl: 30,
}

export const daodaoIcasQuery: Query<
  // List of chain ID and address of ICAs.
  {
    chainId: string
    address: string
  }[],
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-icas',
  parameters: ['chainId', 'address'],
  execute: async ({ chainId, address }, query) =>
    (
      await Promise.allSettled(
        (
          await query(daodaoListItemsWithPrefixQuery, {
            chainId,
            address,
            prefix: 'ica:',
          })
        ).body.map(async ([key]) => ({
          chainId: key,
          address: (
            await query(icaRemoteAddressQuery, {
              address,
              srcChainId: chainId,
              destChainId: key,
            })
          ).body,
        }))
      )
    ).flatMap((p) => (p.status === 'fulfilled' ? p.value : [])),
  ttl: 30,
}

export const daodaoPolytoneAccountsQuery: Query<
  // List of chain ID and address of ICAs.
  {
    chainId: string
    address: string
  }[],
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-polytone-accounts',
  parameters: ['chainId', 'address'],
  // Mapping from polytone note contract to remote proxy address.
  url: ({ chainId, address }) =>
    `${getIndexerUrl(chainId)}/contract/${address}/daoCore/polytoneProxies`,
  transform: (body, { chainId }) =>
    Object.entries(
      polytoneNoteProxyMapToChainIdMap(
        chainId,
        (body || {}) as Record<string, string>
      )
    ).map(([chainId, address]) => ({
      chainId,
      address,
    })),
  ttl: 30,
}

export const daodaoAccountsQuery: Query<
  // List of chain ID and address of ICAs.
  {
    type: string
    chainId: string
    address: string
  }[],
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-accounts',
  parameters: ['chainId', 'address'],
  execute: async ({ chainId, address }, query) => {
    if (address === COMMUNITY_POOL_ADDRESS_PLACEHOLDER) {
      return [
        {
          type: 'base',
          chainId,
          address,
        },
      ]
    }

    const [{ body: isIca }, { body: isPolytoneProxy }] = await Promise.all([
      query(cosmosIsIcaQuery, {
        chainId,
        address,
      }),
      query(daodaoIsPolytoneProxyQuery, {
        chainId,
        address,
      }),
    ])

    // For now, error for ICAs since we can't resolve controller from a host.
    if (isIca) {
      throw new Error('ICA reverse lookup not yet supported')
    }
    // Reverse lookup DAO from polytone proxy.
    if (isPolytoneProxy) {
      try {
        const { body: reverseLookup } = await query(
          daodaoReverseLookupPolytoneProxyQuery,
          {
            chainId,
            proxy: address,
          }
        )

        chainId = reverseLookup.chainId
        address = reverseLookup.address
      } catch (err) {
        if (err instanceof Error && err.message.includes('Invalid chain ID')) {
          throw new Error('Unsupported chain for polytone reverse lookup')
        }

        throw err
      }
    }

    const { body: isDao } = await query(daodaoIsDaoQuery, {
      chainId,
      address,
    })

    if (!isDao) {
      throw new Error('not a DAO')
    }

    const [{ body: icas }, { body: polytoneAccounts }] = await Promise.all([
      await query(daodaoIcasQuery, {
        chainId,
        address,
      }),
      await query(daodaoPolytoneAccountsQuery, {
        chainId,
        address,
      }),
    ])

    return [
      // Native account.
      {
        type: 'base',
        chainId,
        address,
      },
      // Polytone accounts.
      ...polytoneAccounts.map((account) => ({
        type: 'polytone',
        ...account,
      })),
      // ICAs.
      ...icas.map((account) => ({
        type: 'ica',
        ...account,
      })),
    ]
  },
  ttl: 30,
}

export const daodaoTvlQuery: Query<
  ManyValueResponse,
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-tvl',
  parameters: ['chainId', 'address'],
  execute: async ({ chainId, address }, query) => {
    const { body: _accounts } = await query(daodaoAccountsQuery, {
      chainId,
      address,
    })

    const accounts = _accounts
      .map(({ chainId, address }) => `${chainId}:${address}`)
      .join(',')

    const { body: value } = await query(daodaoManyValueQuery, {
      accounts,
    })

    // Add types to accounts.
    value.accounts.forEach((account) => {
      account.type = _accounts.find(
        (a) => a.chainId === account.chainId && a.address === account.address
      )?.type
    })

    return value
  },
  // Update once per 5 minutes.
  ttl: 5 * 60,
}

export const daodaoIndexerContractQuery: Query<
  any,
  {
    chainId: string
    address: string
    formula: string
    // Base64-encoded JSON object.
    args?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-indexer-contract',
  parameters: ['chainId', 'address', 'formula'],
  optionalParameters: ['args'],
  // If args is defined, ensure it parses correctly. Otherwise, no args is also
  // valid.
  validate: ({ args }) =>
    args ? decodeJsonFromBase64(args) !== undefined : true,
  url: ({ chainId, address, formula, args }) =>
    `${getIndexerUrl(chainId)}/contract/${address}/${formula}?${new URLSearchParams(
      decodeJsonFromBase64(args)
    ).toString()}`,
  // Once every 5 seconds, since this may change at every chain block.
  ttl: 5,
}

export const daodaoIsContractQuery: Query<
  boolean,
  {
    chainId: string
    address: string
    name?: string
    names?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-is-contract',
  parameters: ['chainId', 'address'],
  // Only one of `name` or `names` is required. `names` is a comma-separated
  // list of contract names.
  optionalParameters: ['name', 'names'],
  validate: ({ name, names }) => {
    if (!name && !names) {
      throw new Error('Either `name` or `names` is required')
    }

    if (name && names) {
      throw new Error('Only one of `name` or `names` is allowed')
    }

    return true
  },
  execute: async ({ chainId, address, name, names }, query) => {
    let contract: string | undefined
    try {
      const { body } = await query(daodaoIndexerContractQuery, {
        chainId,
        address,
        formula: 'info',
      })
      contract = body.contract
    } catch (err) {
      if (
        err instanceof Error &&
        INVALID_CONTRACT_ERROR_SUBSTRINGS.some((substring) =>
          (err as Error).message.includes(substring)
        )
      ) {
        return false
      }
    }

    // On failure, attempt to load from chain.
    if (!contract) {
      try {
        const { body: data } = await query(cosmosContractStateKeyQuery, {
          chainId,
          address,
          key: 'contract_info',
        })
        const info = data && JSON.parse(data)
        if (info && typeof info.contract === 'string' && info.contract) {
          contract = info.contract
        }
      } catch (err) {
        if (
          err instanceof Error &&
          INVALID_CONTRACT_ERROR_SUBSTRINGS.some((substring) =>
            (err as Error).message.includes(substring)
          )
        ) {
          return false
        }

        // Rethrow other errors because it should not have failed.
        throw err
      }
    }

    return !contract
      ? false
      : name
        ? contract.includes(name)
        : names
          ? names.split(',').some((name) => contract!.includes(name))
          : false
  },
  // Update once per week.
  ttl: 7 * 24 * 60 * 60,
}

export const daodaoIsDaoQuery: Query<
  boolean,
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-is-dao',
  parameters: ['chainId', 'address'],
  execute: async ({ chainId, address }, query) =>
    (
      await query(daodaoIsContractQuery, {
        chainId,
        address,
        names: DAO_CORE_CONTRACT_NAMES.join(','),
      })
    ).body,
  // Update once per week. Really this should never change...
  ttl: 7 * 24 * 60 * 60,
}

export const daodaoIsPolytoneProxyQuery: Query<
  boolean,
  {
    chainId: string
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-is-polytone-proxy',
  parameters: ['chainId', 'address'],
  execute: async ({ chainId, address }, query) =>
    (
      await query(daodaoIsContractQuery, {
        chainId,
        address,
        name: ContractName.PolytoneProxy,
      })
    ).body,
  // Update once per week. Really this should never change...
  ttl: 7 * 24 * 60 * 60,
}

/**
 * Given a polytone proxy, get the source chain, address, and polytone note.
 */
export const daodaoReverseLookupPolytoneProxyQuery: Query<
  {
    chainId: string
    address: string
    note: string
  },
  {
    chainId: string
    proxy: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-reverse-lookup-polytone-proxy',
  parameters: ['chainId', 'proxy'],
  execute: async ({ chainId, proxy }, query) => {
    const { body: voice } = await query(daodaoIndexerContractQuery, {
      chainId,
      address: proxy,
      formula: 'polytone/proxy/instantiator',
    })

    if (typeof voice !== 'string') {
      throw new Error('No voice found')
    }

    const srcPolytoneInfo = POLYTONE_CONFIG_PER_CHAIN.find(([, config]) =>
      Object.entries(config).some(
        ([destChainId, connection]) =>
          destChainId === chainId && connection.voice === voice
      )
    )
    if (!srcPolytoneInfo) {
      throw new Error('No polytone config found for voice')
    }

    const { body: address } = await query(daodaoIndexerContractQuery, {
      chainId,
      address: voice,
      formula: 'polytone/voice/remoteController',
      args: encodeJsonToBase64({
        address: proxy,
      }),
    })

    if (typeof address !== 'string') {
      throw new Error('No address found')
    }

    return {
      chainId: srcPolytoneInfo[0],
      address,
      note: srcPolytoneInfo[1][chainId].note,
    }
  },
  // Update once per week. Really this should never change...
  ttl: 7 * 24 * 60 * 60,
}

/**
 * Fetch all chain IDs that are indexed, including mainnets and testnets.
 */
export const daodaoAllIndexedChainsQuery: Query<string[]> = {
  type: QueryType.Custom,
  name: 'daodao-all-indexed-chains',
  execute: async () => {
    const client = new MeiliSearch({
      host: DAODAO_MEILISEARCH_HOST,
      apiKey: DAODAO_MEILISEARCH_API_KEY,
    })

    // Get all chains with DAOs.
    const chainIds = (
      await client.getIndexes({
        limit: 10000,
      })
    ).results.flatMap((index) => {
      const match = index.uid.match(/^(.+)_daos$/)
      const chainId = match?.[1]
      if (!chainId) {
        return []
      }

      // Check if chain exists.
      if (!maybeGetChainForChainId(chainId)) {
        return []
      }

      return chainId
    })

    return chainIds
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

/**
 * Fetch mainnet chain IDs that are indexed.
 */
export const daodaoIndexedChainsQuery: Query<string[]> = {
  type: QueryType.Custom,
  name: 'daodao-indexed-chains',
  execute: async (_, query) => {
    const { body: allChainIds } = await query(daodaoAllIndexedChainsQuery, {})
    return allChainIds.filter(
      (chainId) =>
        getChainForChainId(chainId).chainRegistry?.network_type === 'mainnet'
    )
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

/**
 * Check whether or not a chain is indexed.
 */
export const daodaoChainIsIndexedQuery: Query<
  boolean,
  {
    chainId: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-chain-is-indexed',
  parameters: ['chainId'],
  execute: async ({ chainId }, query) =>
    (await query(daodaoIndexedChainsQuery, {})).body.includes(chainId),
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainTvlQuery: Query<
  number,
  {
    chainId: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-chain-tvl',
  parameters: ['chainId'],
  execute: async ({ chainId }, query) => {
    const client = new MeiliSearch({
      host: DAODAO_MEILISEARCH_HOST,
      apiKey: DAODAO_MEILISEARCH_API_KEY,
    })

    const index = client.index(`${chainId}_daos`)

    // Get all DAOs from index.
    const daos: string[] = []
    while (true) {
      const res = await index.getDocuments<{ id: string }>({
        limit: 10000,
        offset: daos.length,
      })

      if (res.results.length === 0) {
        break
      }

      // If array is really long, spreading too many arguments into array.push
      // can cause a stack overflow.
      res.results.forEach(({ id }) => daos.push(id))

      if (daos.length === res.total) {
        break
      }
    }

    // Get TVL for each DAO in batches of 100.
    const batch = 100
    let tvl = 0
    for (let i = 0; i < daos.length; i += batch) {
      const tvls = (
        await Promise.allSettled(
          daos.slice(i, i + batch).map((address) =>
            query(daodaoTvlQuery, {
              chainId,
              address,
            })
          )
        )
      ).flatMap((l) => (l.status === 'fulfilled' ? l.value.body.total : []))

      tvls.forEach((daoTvl) => {
        tvl += typeof daoTvl === 'number' ? daoTvl : 0
      })
    }

    return tvl
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoAllTvlQuery: Query<number> = {
  type: QueryType.Custom,
  name: 'daodao-all-tvl',
  execute: async (_, query) => {
    const { body: chainIds } = await query(daodaoIndexedChainsQuery, {})

    // Fetch TVL per-chain sequentially, since it batches internally.
    let tvl = 0
    for (const chainId of chainIds) {
      const chainTvl = await query(daodaoChainTvlQuery, {
        chainId,
      })

      if (typeof chainTvl.body === 'number') {
        tvl += chainTvl.body
      }
    }

    return tvl
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainStatsDaosQuery: Query<
  number,
  {
    chainId: string
    daysAgo?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-chain-stats-daos',
  parameters: ['chainId'],
  optionalParameters: ['daysAgo'],
  url: ({ chainId, daysAgo }) =>
    `${getIndexerUrl(chainId)}/generic/_/stats/daos${daysAgo ? `?daysAgo=${daysAgo}` : ''}`,
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainStatsProposalsQuery: Query<
  number,
  {
    chainId: string
    daysAgo?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-chain-stats-proposals',
  parameters: ['chainId'],
  optionalParameters: ['daysAgo'],
  url: ({ chainId, daysAgo }) =>
    `${getIndexerUrl(chainId)}/generic/_/stats/proposals${daysAgo ? `?daysAgo=${daysAgo}` : ''}`,
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainStatsVotesQuery: Query<
  number,
  {
    chainId: string
    daysAgo?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-chain-stats-votes',
  parameters: ['chainId'],
  optionalParameters: ['daysAgo'],
  url: ({ chainId, daysAgo }) =>
    `${getIndexerUrl(chainId)}/generic/_/stats/votes${daysAgo ? `?daysAgo=${daysAgo}` : ''}`,
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainStatsUniqueVotersQuery: Query<
  number,
  {
    chainId: string
    daysAgo?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-chain-stats-unique-voters',
  parameters: ['chainId'],
  optionalParameters: ['daysAgo'],
  url: ({ chainId, daysAgo }) =>
    `${getIndexerUrl(chainId)}/generic/_/stats/uniqueVoters${daysAgo ? `?daysAgo=${daysAgo}` : ''}`,
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoChainStatsQuery: Query<
  {
    daos: number
    proposals: number
    votes: number
    uniqueVoters: number
  },
  {
    chainId: string
    daysAgo?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-chain-stats',
  parameters: ['chainId'],
  optionalParameters: ['daysAgo'],
  execute: async ({ chainId, daysAgo }, query) => {
    const [
      { body: daos },
      { body: proposals },
      { body: votes },
      { body: uniqueVoters },
    ] = await Promise.all([
      query(daodaoChainStatsDaosQuery, {
        chainId,
        daysAgo,
      }),
      query(daodaoChainStatsProposalsQuery, {
        chainId,
        daysAgo,
      }),
      query(daodaoChainStatsVotesQuery, {
        chainId,
        daysAgo,
      }),
      query(daodaoChainStatsUniqueVotersQuery, {
        chainId,
        daysAgo,
      }),
    ])

    return {
      daos,
      proposals,
      votes,
      uniqueVoters,
    }
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

export const daodaoAllStatsQuery: Query<
  {
    daos: number
    proposals: number
    votes: number
    uniqueVoters: number
  },
  {
    daysAgo?: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-all-stats',
  optionalParameters: ['daysAgo'],
  execute: async ({ daysAgo }, query) => {
    const { body: chainIds } = await query(daodaoIndexedChainsQuery, {})

    // Fetch stats for all chains.
    const allStats = (
      await Promise.allSettled(
        chainIds.map((chainId) =>
          query(daodaoChainStatsQuery, {
            chainId,
            daysAgo,
          })
        )
      )
    ).flatMap((p) => (p.status === 'fulfilled' ? p.value.body : []))

    return {
      daos: allStats.reduce((sum, { daos }) => sum + daos, 0),
      proposals: allStats.reduce((sum, { proposals }) => sum + proposals, 0),
      votes: allStats.reduce((sum, { votes }) => sum + votes, 0),
      uniqueVoters: allStats.reduce(
        (sum, { uniqueVoters }) => sum + uniqueVoters,
        0
      ),
    }
  },
  // Update once per day.
  ttl: 24 * 60 * 60,
}

/**
 * Resolve a DAO's info, including chain ID, from only its core address. This
 * only works for indexed chains.
 */
export const daodaoDaoInfoQuery: Query<
  any,
  {
    address: string
  }
> = {
  type: QueryType.Custom,
  name: 'daodao-dao-info',
  parameters: ['address'],
  execute: async ({ address }, query) => {
    const { body: chainIds } = await query(daodaoAllIndexedChainsQuery, {})

    const client = new MeiliSearch({
      host: DAODAO_MEILISEARCH_HOST,
      apiKey: DAODAO_MEILISEARCH_API_KEY,
    })

    // Return the first successful resolution.
    let errors = 0
    return await Promise.race(
      chainIds.map((chainId) =>
        client
          .index(`${chainId}_daos`)
          .getDocument(address)
          .then((doc) => {
            const mainnet =
              getChainForChainId(chainId).chainRegistry?.network_type ===
              'mainnet'
            return {
              chainId,
              url: `https://${mainnet ? '' : 'testnet.'}daodao.zone/dao/${address}`,
              ...doc,
            }
          })
          .catch(() => {
            errors++

            // If this is the last query and it failed, throw error to stop the
            // race.
            if (errors === chainIds.length) {
              throw new Error('No DAO found')
            }

            // Return a never-resolving promise to keep the race going.
            return new Promise(() => {})
          })
      )
    )
  },
  // Never need to update this query.
  ttl: 0,
}

/**
 * Fetch and cache indexer response for a variable TTL.
 */
export const daodaoIndexerQuery: Query<
  any,
  {
    type: string
    formula: string
    chainId: string
    address: string
    args?: string
    ttl?: string
  }
> = {
  type: QueryType.Url,
  name: 'daodao-indexer',
  parameters: ['type', 'formula', 'chainId', 'address'],
  optionalParameters: ['args', 'ttl'],
  url: ({ type, formula, chainId, address, args }) =>
    `${getIndexerUrl(chainId)}/${type}/${address}/${formula}${args ? `?${args}` : ''}`,
  // Set minimum to 1 second and maximum to 1 week. Default to 5 minutes.
  ttl: ({ ttl }) =>
    ttl && !isNaN(Number(ttl))
      ? Math.min(Math.max(1, Number(ttl)), 7 * 24 * 60 * 60)
      : 5 * 60,
}
