import { IBCInfo } from '@chain-registry/types'
import { ibc } from '@dao-dao/types/protobuf'
import { IdentifiedChannel } from '@dao-dao/types/protobuf/codegen/ibc/core/channel/v1/channel'
import {
  getAllRpcResponse,
  getChainForChainId,
  getRpcForChainId,
  retry,
} from '@dao-dao/utils'

import { Query, QueryType } from '@/types'

export const ibcChainRegistryQuery: Query<
  IBCInfo,
  {
    // Chain name.
    a: string
    // Chain name.
    b: string
  }
> = {
  type: QueryType.Url,
  name: 'ibc-chain-registry',
  parameters: ['a', 'b'],
  url: ({ a, b }) =>
    `https://raw.githubusercontent.com/cosmos/chain-registry/master/_IBC/${a}-${b}.json`,
  // Cache for 24 hours.
  ttl: 24 * 60 * 60,
}

export const ibcTransferInfoQuery: Query<
  {
    sourceChain: IBCInfo['chain_1']
    destinationChain: IBCInfo['chain_1']
    sourceChannel: string
    info: IBCInfo
  },
  {
    srcChainId: string
    destChainId: string
  }
> = {
  type: QueryType.Custom,
  name: 'ibc-transfer-info',
  parameters: ['srcChainId', 'destChainId'],
  validate: ({ srcChainId, destChainId }) => {
    if (!getChainForChainId(srcChainId)) {
      return Error('Invalid source chain.')
    }
    if (!getChainForChainId(destChainId)) {
      return Error('Invalid destination chain.')
    }
    return true
  },
  execute: async ({ srcChainId, destChainId }, query) => {
    const srcChain = getChainForChainId(srcChainId)
    const destChain = getChainForChainId(destChainId)

    // Type-check, should already be validated above.
    if (!srcChain || !destChain) {
      throw new Error('Invalid source or destination chain.')
    }

    // Try both orderings since it could be either.
    const info = (
      await Promise.allSettled([
        query(ibcChainRegistryQuery, {
          a: srcChain.chainName,
          b: destChain.chainName,
        }),
        query(ibcChainRegistryQuery, {
          a: destChain.chainName,
          b: srcChain.chainName,
        }),
      ])
    ).flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )[0]?.body

    if (!info) {
      throw new Error(
        `Failed to find IBC info from chain ${srcChainId} to chain ${destChainId}.`
      )
    }

    const srcChainNumber =
      info.chain_1.chain_name === srcChain.chainName ? 1 : 2
    const destChainNumber =
      info.chain_1.chain_name === destChain.chainName ? 1 : 2
    const channel = info.channels.find(
      ({
        [`chain_${srcChainNumber}` as `chain_${typeof srcChainNumber}`]:
          srcChain,
        [`chain_${destChainNumber}` as `chain_${typeof srcChainNumber}`]:
          destChain,
        version,
      }) =>
        version === 'ics20-1' &&
        srcChain.port_id === 'transfer' &&
        destChain.port_id === 'transfer'
    )
    if (!channel) {
      throw new Error(
        `Failed to find IBC channel from chain ${srcChainId} to chain ${destChainId}.`
      )
    }

    return {
      sourceChain: info[`chain_${srcChainNumber}`],
      sourceChannel: channel[`chain_${srcChainNumber}`].channel_id,
      destinationChain: info[`chain_${destChainNumber}`],
      info,
    }
  },
  // Cache for 24 hours.
  ttl: 24 * 60 * 60,
}

export const icaRemoteAddressQuery: Query<
  string,
  {
    address: string
    srcChainId: string
    destChainId: string
  }
> = {
  type: QueryType.Custom,
  name: 'ica-remote-address',
  parameters: ['address', 'srcChainId', 'destChainId'],
  validate: ({ srcChainId, destChainId }) => {
    if (!getChainForChainId(srcChainId)) {
      return Error('Invalid source chain.')
    }
    if (!getChainForChainId(destChainId)) {
      return Error('Invalid destination chain.')
    }
    return true
  },
  execute: async ({ address, srcChainId, destChainId }, query) => {
    const {
      body: {
        sourceChain: { connection_id },
      },
    } = await query(ibcTransferInfoQuery, {
      srcChainId,
      destChainId,
    })

    const client: Awaited<
      ReturnType<typeof ibc.ClientFactory.createRPCQueryClient>
    > = await retry(5, (attempt) =>
      ibc.ClientFactory.createRPCQueryClient({
        rpcEndpoint: getRpcForChainId(srcChainId, attempt),
      })
    )

    return (
      await client.ibc.applications.interchain_accounts.controller.v1.interchainAccount(
        {
          owner: address,
          connectionId: connection_id,
        }
      )
    ).address
  },
  // Cache for 1 hour.
  ttl: 24 * 60,
}

export const icaChannelQuery: Query<
  IdentifiedChannel,
  {
    address: string
    srcChainId: string
    destChainId: string
  }
> = {
  type: QueryType.Custom,
  name: 'ica-channel',
  parameters: ['address', 'srcChainId', 'destChainId'],
  validate: ({ srcChainId, destChainId }) => {
    if (!getChainForChainId(srcChainId)) {
      return Error('Invalid source chain.')
    }
    if (!getChainForChainId(destChainId)) {
      return Error('Invalid destination chain.')
    }
    return true
  },
  execute: async ({ address, srcChainId, destChainId }, query) => {
    const {
      body: {
        sourceChain: { connection_id },
      },
    } = await query(ibcTransferInfoQuery, {
      srcChainId,
      destChainId,
    })

    const client: Awaited<
      ReturnType<typeof ibc.ClientFactory.createRPCQueryClient>
    > = await retry(5, (attempt) =>
      ibc.ClientFactory.createRPCQueryClient({
        rpcEndpoint: getRpcForChainId(srcChainId, attempt),
      })
    )

    // The port ID is derived from the address of the controller.
    const controllerPortId = `icacontroller-${address}`

    // Get all channels for the connection until we find the one for the
    // controller.
    const channels = await getAllRpcResponse(
      client.ibc.core.channel.v1.connectionChannels.bind(
        client.ibc.core.channel.v1
      ),
      {
        connection: connection_id,
      },
      'channels',
      undefined,
      undefined,
      (channels) => channels.some(({ portId }) => portId === controllerPortId)
    )

    // Attempt to find the channel for the controller.
    const channel = channels.find(({ portId }) => portId === controllerPortId)
    if (!channel) {
      throw new Error(
        `Failed to find ICA channel for address ${address} on chain ${srcChainId}.`
      )
    }

    return channel
  },
  // Cache for 1 hour.
  ttl: 24 * 60,
}
