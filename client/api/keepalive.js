/**
 * 后台保持连接。
 *
 * uni-app 没有前台服务 API，所以这里能做的是两件事：
 *   1. 屏幕常亮/CPU 唤醒锁（`plus.device.setWakelock`），减少息屏后被挂起的概率；
 *   2. 引导用户把 shou 加进系统的电池优化白名单（Android 用反射打开那个设置页）。
 *
 * 说清楚边界：这两条都是**缓解**而不是保证。Android 在内存紧张时仍可能冻结后台进程，
 * 真正可靠的做法是前台服务（需要原生插件），那是 v0.2 的事。
 */

import { state } from '../store/app.js'

let wakelockOn = false

export function applyKeepAlive() {
  if (typeof plus === 'undefined') return
  const want = state.keepAlive
  try {
    if (want && !wakelockOn) {
      plus.device.setWakelock(true)
      wakelockOn = true
    } else if (!want && wakelockOn) {
      plus.device.setWakelock(false)
      wakelockOn = false
    }
  } catch {
    /* 平台不支持时忽略 */
  }
}

/** 当前是否已在电池优化白名单里。拿不到就返回 null（界面显示"未知"）。 */
export function isIgnoringBatteryOptimizations() {
  if (typeof plus === 'undefined' || !plus.android) return null
  try {
    const Context = plus.android.importClass('android.content.Context')
    const activity = plus.android.runtimeMainActivity()
    const PowerManager = plus.android.importClass('android.os.PowerManager')
    const pm = activity.getSystemService(Context.POWER_SERVICE)
    return pm.isIgnoringBatteryOptimizations(activity.getPackageName())
  } catch {
    return null
  }
}

/**
 * 打开系统的电池优化设置。
 *
 * 优先直接申请忽略（`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`），
 * 失败则退到应用详情页让用户自己操作——国内 ROM 经常把前者的入口藏起来。
 */
export function requestBatteryExemption() {
  if (typeof plus === 'undefined' || !plus.android) return false
  try {
    const Intent = plus.android.importClass('android.content.Intent')
    const Uri = plus.android.importClass('android.net.Uri')
    const Settings = plus.android.importClass('android.provider.Settings')
    const activity = plus.android.runtimeMainActivity()

    const request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
    request.setData(Uri.parse('package:' + activity.getPackageName()))
    activity.startActivity(request)
    return true
  } catch {
    return openAppDetails()
  }
}

export function openAppDetails() {
  if (typeof plus === 'undefined' || !plus.android) return false
  try {
    const Intent = plus.android.importClass('android.content.Intent')
    const Uri = plus.android.importClass('android.net.Uri')
    const Settings = plus.android.importClass('android.provider.Settings')
    const activity = plus.android.runtimeMainActivity()
    const intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
    intent.setData(Uri.parse('package:' + activity.getPackageName()))
    activity.startActivity(intent)
    return true
  } catch {
    return false
  }
}
