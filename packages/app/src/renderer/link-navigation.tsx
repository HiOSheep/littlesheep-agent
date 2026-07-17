import { createContext, useContext, type ReactNode } from 'react'

export interface LinkNavigation {
  openInside: (href: string) => void
  openWithSystem: (href: string) => void
}

const LinkNavigationContext = createContext<LinkNavigation>({
  openInside: () => undefined,
  openWithSystem: () => undefined,
})

export function LinkNavigationProvider({
  value,
  children,
}: {
  value: LinkNavigation
  children: ReactNode
}) {
  return (
    <LinkNavigationContext.Provider value={value}>
      {children}
    </LinkNavigationContext.Provider>
  )
}

export function useLinkNavigation(): LinkNavigation {
  return useContext(LinkNavigationContext)
}
