import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import type { RunActivityMonitor } from './run-activity-monitor.js'

const MAX_VISIBLE_TRAY_RUNS = 6
const TRAY_REFRESH_DEBOUNCE_MS = 80

export interface TrayControllerOptions {
  iconPath: string
  activity: RunActivityMonitor
  onShow: () => void
  onQuit: () => void
  onWarning?: (message: string) => void
}

export class LittleSheepTrayController {
  private readonly tray: Tray
  private readonly activity: RunActivityMonitor
  private readonly onShow: () => void
  private readonly onQuit: () => void
  private readonly onWarning: (message: string) => void
  private readonly unsubscribe: () => void
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(options: TrayControllerOptions) {
    this.activity = options.activity
    this.onShow = options.onShow
    this.onQuit = options.onQuit
    this.onWarning = options.onWarning ?? (() => undefined)
    this.tray = new Tray(options.iconPath)
    this.tray.on('click', this.onShow)
    this.unsubscribe = this.activity.subscribe(() => this.scheduleRefresh())
    this.refresh()
  }

  get available(): boolean {
    return !this.disposed && !this.tray.isDestroyed()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.unsubscribe()
    this.tray.removeListener('click', this.onShow)
    this.tray.destroy()
  }

  private scheduleRefresh(): void {
    if (this.disposed) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.refresh()
    }, TRAY_REFRESH_DEBOUNCE_MS)
    this.refreshTimer.unref?.()
  }

  private refresh(): void {
    if (!this.available) return
    const runs = this.activity.snapshot()
    this.tray.setToolTip(runs.length > 0 ? `LittleSheep · ${runs.length} 个任务进行中` : 'LittleSheep')
    this.tray.setContextMenu(Menu.buildFromTemplate(this.buildMenu(runs)))
  }

  private buildMenu(runs: RuntimeActiveRunSnapshot[]): MenuItemConstructorOptions[] {
    const visibleRuns = runs.slice(0, MAX_VISIBLE_TRAY_RUNS)
    const runItems: MenuItemConstructorOptions[] = visibleRuns.map((run, index) => ({
      label: `${index + 1}. ${runLabel(run)}`,
      submenu: [
        { label: runDetail(run), enabled: false },
        { type: 'separator' },
        { label: '显示 LittleSheep', click: this.onShow },
        {
          label: run.controlStatus === 'pause_requested' ? '继续任务' : '暂停任务',
          enabled: run.controlStatus !== 'interrupt_requested',
          click: () => this.control(run, run.controlStatus === 'pause_requested' ? 'resume' : 'pause'),
        },
        {
          label: '中断任务',
          enabled: run.controlStatus !== 'interrupt_requested',
          click: () => this.control(run, 'interrupt'),
        },
      ],
    }))
    if (runs.length > visibleRuns.length) {
      runItems.push({ label: `另有 ${runs.length - visibleRuns.length} 个活动任务`, enabled: false })
    }

    return [
      { label: 'LittleSheep', enabled: false },
      {
        label: runs.length > 0 ? `${runs.length} 个任务进行中` : '当前没有活动任务',
        enabled: false,
      },
      ...(runItems.length > 0 ? [{ type: 'separator' as const }, ...runItems] : []),
      { type: 'separator' },
      { label: '显示 LittleSheep', click: this.onShow },
      { label: '彻底退出', click: this.onQuit },
    ]
  }

  private control(run: RuntimeActiveRunSnapshot, action: RuntimeActiveRunAction): void {
    const outcome = this.activity.request(run.runId, action, `tray-${action}`)
    if (outcome.kind === 'rejected') this.onWarning(outcome.message)
    this.scheduleRefresh()
  }
}

function runLabel(run: RuntimeActiveRunSnapshot): string {
  if (run.controlStatus === 'interrupt_requested') return '正在中断'
  if (run.controlStatus === 'pause_requested') return '等待暂停'
  const step = run.activeSteps[0]?.title
  if (step) return boundedText(step, 42)
  if (run.phase === 'verifying') return '正在验证'
  if (run.phase === 'finalizing') return '正在整理结果'
  if (run.phase === 'executing') return '正在执行'
  return '正在处理'
}

function runDetail(run: RuntimeActiveRunSnapshot): string {
  const progress = run.totalSteps > 0 ? `${run.completedSteps}/${run.totalSteps} 步` : '尚未生成步骤'
  const source = run.origin === 'channel' ? '外部渠道' : run.origin === 'app' ? '本地应用' : run.origin.toUpperCase()
  return `${source} · ${progress} · 会话 ${boundedText(String(run.sessionId), 12)}`
}

function boundedText(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(1, length - 1))}…`
}
