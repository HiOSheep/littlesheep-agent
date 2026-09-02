// Settings navigation and page composition.
import { SETTINGS_NAV_GROUPS } from './navigation'
import { SettingsPage } from './types'
import { SettingsNavArrowIcon } from '../ui/icons'


export function SettingsHome({ onOpenPage }: { onOpenPage: (page: SettingsPage) => void }) {
  return (
    <div className="settings-home">
      <div className="settings-home-heading">
        <h2>设置</h2>
        <p>系统能力、渠道、记忆和后续功能模块都会归入这里。</p>
      </div>
      <div className="settings-overview-list">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => item.page !== 'home')
          if (items.length === 0) return null
          return (
            <section key={group.title} className="settings-overview-group">
              <div className="settings-overview-group-title">{group.title}</div>
              <div className="settings-overview-group-items">
                {items.map((item) => (
                  <button
                    key={item.page}
                    className="settings-overview-row"
                    type="button"
                    onClick={() => onOpenPage(item.page)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.desc}</span>
                    <SettingsNavArrowIcon />
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
