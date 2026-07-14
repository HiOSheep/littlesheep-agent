// Settings navigation and page composition.
import { ScheduleIcon } from '../ui/icons'


export function SettingsScheduledPage() {
  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">工作</div>
        <h2>已安排</h2>
        <p>计划任务、提醒和周期执行会集中在这里。</p>
      </header>
      <div className="settings-module-toolbar" role="toolbar" aria-label="已安排筛选">
        <button className="settings-filter-pill active" type="button">全部</button>
        <button className="settings-filter-pill" type="button">提醒</button>
        <button className="settings-filter-pill" type="button">自动任务</button>
      </div>
      <div className="settings-module-empty">
        <div className="settings-module-empty-icon" aria-hidden="true">
          <ScheduleIcon />
        </div>
        <strong>暂无已安排任务</strong>
        <span>等计划任务接入后，这里会显示待执行、周期执行和已暂停的项目。</span>
      </div>
    </div>
  )
}
