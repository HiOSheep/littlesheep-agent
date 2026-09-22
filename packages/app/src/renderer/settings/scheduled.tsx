// Settings navigation and page composition.
import { ScheduleIcon } from '../ui/icons'


export function SettingsScheduledPage() {
  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">工作</div>
        <h2>已安排</h2>
        <p>计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用。</p>
      </header>
      <div className="settings-module-empty">
        <div className="settings-module-empty-icon" aria-hidden="true">
          <ScheduleIcon />
        </div>
        <strong>功能尚未接入</strong>
        <span>当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用。</span>
      </div>
    </div>
  )
}
