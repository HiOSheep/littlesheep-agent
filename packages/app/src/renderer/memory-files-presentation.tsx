import type { MemoryActivationProjection } from './api'

export function MemoryActivationLevels({ activation }: { activation: MemoryActivationProjection }) {
  const levels = [
    { id: 'high', label: '高', count: activation.levels.high },
    { id: 'medium', label: '中', count: activation.levels.medium },
    { id: 'low', label: '低', count: activation.levels.low },
  ] as const

  return (
    <section className="memory-activation-projection" aria-label="记忆激活层级">
      <span className="memory-activation-title">记忆活跃度</span>
      <div className="memory-activation-levels">
        {levels.map((level) => (
          <div key={level.id} className={`memory-activation-level ${level.id}`}>
            <span className="memory-activation-dot" aria-hidden="true" />
            <span>{level.label}</span>
            <strong>{level.count}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

export function formatMemoryFileBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}
