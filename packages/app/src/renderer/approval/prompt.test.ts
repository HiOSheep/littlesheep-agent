import { describe, expect, it } from 'vitest'
import { approvalActionRiskDescription } from './prompt'

describe('approvalActionRiskDescription', () => {
  it('identifies approved Agent commands as host execution without OS isolation', () => {
    const description = approvalActionRiskDescription('exec', 'agent')

    expect(description).toContain('宿主环境运行')
    expect(description).toContain('没有为 Agent Shell 提供操作系统级沙箱')
    expect(description).toContain('工作区边界不会限制该命令')
    expect(description).toContain('其他文件、启动本地进程或使用网络')
  })

  it('keeps non-shell approval explanations scoped to their existing action', () => {
    const description = approvalActionRiskDescription('write', 'agent')

    expect(description).toContain('修改所示文件')
    expect(description).not.toContain('宿主环境运行')
  })

  it('describes workspace terminal commands without mislabeling them as Agent calls', () => {
    const description = approvalActionRiskDescription('exec', 'workspace')

    expect(description).toContain('你的交互式终端中以当前用户权限运行')
    expect(description).toContain('不会为该终端命令提供操作系统级沙箱')
    expect(description).not.toContain('Agent Shell')
  })
})
