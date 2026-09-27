// Settings navigation and page composition.
//
// 总览只做两件事（S1）：列出少数常用入口，以及列出**有真实证据**、需要用户处理的配置问题。
// 它不再复制整份目录——完整目录始终在左侧导航里，重复一遍只会让总览变成第二份侧栏。
// “需要处理”的判定只读 Runtime 已经给出的字段，不额外发请求、不发明健康分或状态仪表盘。
import { isConfiguredProvider } from './model-provider-draft'
import {
  commonSettingsNavGroups,
  SETTINGS_HOME_COMMON_PAGES
} from './navigation'
import { SettingsPage } from './types'
import { RuntimeState } from '../api'
import { SettingsNavArrowIcon } from '../ui/icons'


interface SettingsHomeProblem {
  /** 稳定的键，供测试与将来去重使用。 */
  id: 'model-provider-missing' | 'model-provider-unusable'
  title: string
  detail: string
  /** 用户能去处理这个问题的页面。 */
  page: SettingsPage
  action: string
}

/**
 * 需要用户处理的配置问题。
 *
 * 证据边界：只使用 `runtime.providers` 里已有的字段和设置页自己的 `isConfiguredProvider` 判定
 * （与输入栏“还没有配置模型”用的是同一个谓词，所以两处不会互相矛盾）。“网络检索未配置”一类
 * 的提示故意不在这里出现：Runtime 没有把“用户需要处理”作为事实提供出来，凭偏好猜测只会变成噪音。
 */
export function settingsHomeProblems(runtime: RuntimeState | null): SettingsHomeProblem[] {
  const providers = runtime?.providers ?? []
  if (!providers.some(isConfiguredProvider)) {
    return [{
      id: 'model-provider-missing',
      title: '还没有配置模型',
      detail: '没有可用供应商时，对话无法调用模型。在「模型供应商」里添加服务、密钥和模型条目。',
      page: 'api',
      action: '配置模型',
    }]
  }

  const selectableModels = providers
    .filter(isConfiguredProvider)
    .reduce((total, provider) => total + provider.models.length, 0)
  if (selectableModels === 0) {
    return [{
      id: 'model-provider-unusable',
      title: '已配置的供应商还没有可用模型',
      detail: '供应商已保存，但还没有可选择的模型：可能缺少 API 密钥，或没有填写模型条目。保存配置不代表已经验证可以调用。',
      page: 'api',
      action: '检查供应商配置',
    }]
  }

  return []
}

export function SettingsHome({
  runtime,
  onOpenPage,
}: {
  runtime: RuntimeState | null
  onOpenPage: (page: SettingsPage) => void
}) {
  const commonItems = commonSettingsNavGroups()
    .flatMap((group) => group.items)
    .filter((item) => SETTINGS_HOME_COMMON_PAGES.includes(item.page))
    .sort((left, right) => (
      SETTINGS_HOME_COMMON_PAGES.indexOf(left.page) - SETTINGS_HOME_COMMON_PAGES.indexOf(right.page)
    ))
  const problems = settingsHomeProblems(runtime)

  return (
    <div className="settings-home">
      <div className="settings-home-heading">
        <h2>设置</h2>
        <p>常用设置与需要处理的配置问题；完整目录在左侧，也可以用搜索直接找。</p>
      </div>
      {problems.length > 0 && (
        <section className="settings-overview-group" aria-label="需要处理的配置问题">
          <div className="settings-overview-group-title">需要处理</div>
          <div className="settings-overview-group-items">
            {problems.map((problem) => (
              <div key={problem.id} className="settings-overview-row" data-tone="attention">
                <strong>{problem.title}</strong>
                <span>{problem.detail}</span>
                <button type="button" onClick={() => onOpenPage(problem.page)}>{problem.action}</button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="settings-overview-group" aria-label="常用设置">
        <div className="settings-overview-group-title">常用设置</div>
        <div className="settings-overview-group-items">
          {commonItems.map((item) => (
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
    </div>
  )
}
