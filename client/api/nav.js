/**
 * 页面跳转的防重与失败可见化。
 *
 * 两个真机上会遇到的问题：
 *   1. 连点两下卡片会 push 两个同样的页面；页面栈有上限（10 层），堆满之后
 *      `navigateTo` 直接失败——表现就是"有时候点不进去"，而且**完全没有提示**。
 *   2. 跳转失败被 uni 静默吞掉，用户只看到点了没反应。
 *
 * 所以这里做一道 800 毫秒的节流，并把失败如实弹出来。
 */

let lockedUntil = 0

export function safeNavigate(url, { message = '打不开这个页面' } = {}) {
  const now = Date.now()
  if (now < lockedUntil) return false
  lockedUntil = now + 800

  uni.navigateTo({
    url,
    fail: () => {
      // 失败就立刻解锁，否则下一次点击会被这次失败白白吃掉 800 毫秒。
      lockedUntil = 0
      uni.showToast({ title: message, icon: 'none' })
    },
  })
  return true
}

/** 需要立刻再跳一次时（例如重试按钮）手动解锁。 */
export function releaseNavigationLock() {
  lockedUntil = 0
}
