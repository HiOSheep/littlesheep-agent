// Settings navigation and page composition.
import { StateView } from '../ui/state-view'


export function SettingsScheduledPage() {
  return (
    <div className="settings-module-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">工作</div>
        <h2>已安排</h2>
        <p>计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用。</p>
      </header>
      {/*
        Unavailable, not empty. The capability is not connected, so this page renders the
        shared state view with the reason it cannot be used (`ui/state-view.tsx` makes the
        reason mandatory in the type, `ui/state-view-specs.ts` marks the state as
        reason-requiring) instead of an empty-list box. "Nothing here" would be a false
        claim: the query never ran, because there is nothing behind it to query
        (audit finding #20, V3 "不可用功能不显示成空数据").
      */}
      <StateView
        state="unavailable"
        title="功能尚未接入"
        description="当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用。"
        reason="Runtime 目前还没有计划任务能力。"
      />
    </div>
  )
}
