export function runRenderTask(payload = {}) {
  return {
    ok: false,
    code: 'RENDER_TEMPLATE_INVALID',
    message: 'Render worker is not implemented yet.',
    payload,
  }
}
