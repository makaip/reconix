import type { ReactNode } from 'react'

type BadgeProps = {
  /** note that "muted" is the translucent grey pill and "raised" the solid raised-surface pill */
  tone?: 'muted' | 'raised' | 'success'
  children: ReactNode
}

function Badge({ tone = 'raised', children }: BadgeProps): JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export default Badge
