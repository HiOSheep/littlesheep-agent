// Reusable renderer interaction primitives and icons.


export function beginResize(axis: 'column'): void {
  document.body.classList.add('is-resizing', `is-resizing-${axis}`)
}


export function endResize(axis: 'column'): void {
  document.body.classList.remove(`is-resizing-${axis}`)
  if (!document.body.classList.contains('is-resizing-column')) {
    document.body.classList.remove('is-resizing')
  }
}
