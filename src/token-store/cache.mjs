export function createTtlCache(ttlMs) {
  let state = {
    value: null,
    cachedAt: 0,
  }

  return Object.freeze({
    get(now = Date.now()) {
      if (state.value === null) return null
      if ((now - state.cachedAt) >= ttlMs) return null
      return state.value
    },

    set(value, now = Date.now()) {
      state = {
        value,
        cachedAt: now,
      }
      return value
    },

    clear() {
      state = {
        value: null,
        cachedAt: 0,
      }
    },
  })
}
