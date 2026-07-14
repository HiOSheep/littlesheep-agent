// Reusable renderer interaction primitives and icons.

export const COMPOSER_MENU_EVENT = 'littlesheep:composer-menu-open'

export const SIDEBAR_MENU_EVENT = 'littlesheep:sidebar-menu-open'

export const WORKSPACE_MENU_EVENT = 'littlesheep:workspace-menu-open'

export const TRANSIENT_TRIGGER_ATTR = 'data-ls-transient-trigger'


export function isTransientTriggerTarget(target: Node): boolean {
  return target instanceof Element && Boolean(target.closest(`[${TRANSIENT_TRIGGER_ATTR}]`))
}


export function transientTriggerProps(): { [TRANSIENT_TRIGGER_ATTR]: string } {
  return { [TRANSIENT_TRIGGER_ATTR]: 'true' }
}
