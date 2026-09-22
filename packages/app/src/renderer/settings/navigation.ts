// Settings navigation and page composition.
import { SettingsNavGroup } from './types'


export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: '通用',
    items: [
      { page: 'home', title: '总览', desc: '系统状态与基础入口' },
      { page: 'application', title: '应用与后台', desc: '窗口关闭方式与活动任务控制' },
      { page: 'appearance', title: '界面', desc: '对话显示密度与显示偏好' },
      { page: 'agent', title: 'Agent 行为', desc: '通用与编程两套系统提示词' },
      { page: 'api', title: '模型供应商', desc: 'API 密钥与可用模型' },
      { page: 'web', title: '网络检索', desc: '公开资料、来源与缓存策略' },
      { page: 'storage', title: '存储与数据', desc: '数据位置、迁移与回滚' },
      { page: 'browser', title: '内置浏览器', desc: '站点数据、登录状态与缓存管理' },
      { page: 'developmentEnvironments', title: '开发环境', desc: 'LS 运行时、工具链和版本偏好' },
    ],
  },
  {
    title: '工作',
    items: [
      { page: 'scheduled', title: '已安排', desc: '计划任务尚未接入' },
      { page: 'archive', title: '归档', desc: '归档项目和对话管理' },
    ],
  },
  {
    title: '记忆',
    items: [
      { page: 'memoryTree', title: '记忆树', desc: '长期记忆、项目分支和每日召回' },
    ],
  },
  {
    title: '扩展',
    items: [
      { page: 'plugins', title: '插件', desc: '本地插件与工具连接' },
      { page: 'skills', title: '技能', desc: '本地技能、工具说明和可复用能力' },
    ],
  },
  {
    title: '连接',
    items: [
      { page: 'channels', title: '外部渠道', desc: '通讯渠道连接与重新加载' },
    ],
  },
]
