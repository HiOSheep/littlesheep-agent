// Overall channel health, derived from the same per-item facts the list shows.
//
// A loaded channel entry is not a running channel: `channels` holds the
// instances the plugin host created, and each one reports `running`. The
// summary therefore counts running items and failures instead of treating
// "configured exists" or "the list is not empty" as connection health.
//
// Contract: the host lists only *running* instances (a stopped channel leaves
// the manager's running table, a channel that never started becomes a failure
// entry) — see `shared/channel-control-contracts.ts` and the `list` cases in
// `packages/plugins/src/channel/manager.test.ts`. The running count therefore
// cannot be replaced by the list length even though both agree today: the
// count is what tells the user how many configured channels are actually up,
// and the per-item `running` branch stays as a defensive path.
import type { ChannelConnectionsStatus } from '../shared/channel-control-contracts'

export type ChannelOverallKind = 'unconfigured' | 'stopped' | 'partial' | 'running'

export interface ChannelOverall {
  kind: ChannelOverallKind
  label: string
  /** Per-fact counters shown with the label; empty when nothing is configured. */
  counts: string
  /** One-sentence statement of the same facts, used for the accessible title. */
  detail: string
  loadedCount: number
  runningCount: number
  configuredCount: number
  enabledCount: number
  failureCount: number
}

export function summarizeChannelConnections(status: ChannelConnectionsStatus): ChannelOverall {
  const loadedCount = status.channels.length
  const runningCount = status.channels.filter((channel) => channel.running).length
  const configuredCount = status.configured.length
  const enabledCount = status.configured.filter((channel) => channel.enabled).length
  const failureCount = status.failures.length
  const counts = {
    loadedCount, runningCount, configuredCount, enabledCount, failureCount,
  }
  const counter = channelCountText(counts)

  if (configuredCount === 0 && loadedCount === 0) {
    return {
      ...counts,
      kind: 'unconfigured',
      label: '未配置外部渠道',
      counts: '',
      detail: failureCount > 0
        ? `还没有配置外部渠道，但已有 ${failureCount} 项启动失败记录。`
        : '还没有配置外部渠道，当前没有渠道在运行。',
    }
  }

  if (runningCount > 0 && runningCount === loadedCount && failureCount === 0) {
    return {
      ...counts,
      kind: 'running',
      label: '外部渠道运行中',
      counts: counter,
      detail: `已加载 ${loadedCount} 个渠道，全部运行中。`,
    }
  }

  if (runningCount > 0) {
    return {
      ...counts,
      kind: 'partial',
      label: '部分渠道运行中',
      counts: counter,
      detail: failureCount > 0
        ? `已加载 ${loadedCount} 个渠道，${runningCount} 个运行中，另有 ${failureCount} 项启动失败。`
        : `已加载 ${loadedCount} 个渠道，只有 ${runningCount} 个在运行。`,
    }
  }

  // Nothing is running. In the reachable case that means every configured
  // channel is disabled and none was started, so the sentence states the
  // configuration facts instead of calling never-started channels "未运行".
  if (failureCount > 0) {
    return {
      ...counts,
      kind: 'stopped',
      label: '外部渠道未运行',
      counts: counter,
      detail: `已配置 ${configuredCount} 个渠道（${enabledCount} 个启用），当前没有渠道在运行，另有 ${failureCount} 项启动失败。`,
    }
  }

  return {
    ...counts,
    kind: 'stopped',
    label: '外部渠道未运行',
    counts: counter,
    detail: `已配置 ${configuredCount} 个渠道（${enabledCount} 个启用），当前没有渠道在运行。`,
  }
}

function channelCountText(counts: {
  loadedCount: number
  runningCount: number
  configuredCount: number
  enabledCount: number
  failureCount: number
}): string {
  const parts = [`运行 ${counts.runningCount}/${counts.loadedCount}`]
  parts.push(`已配置 ${counts.configuredCount}`)
  if (counts.failureCount > 0) parts.push(`失败 ${counts.failureCount}`)
  return parts.join(' · ')
}
