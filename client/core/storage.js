/**
 * 存储适配层。
 *
 * 业务代码只依赖 `createStorage()` 返回的 get/set/remove 三个方法，测试里换成内存实现
 * 即可在 Node 下跑全部内核逻辑。端上走 uni 的同步存储。
 */

/** 内存实现——单测与不支持 uni 的环境使用。 */
export function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    get(key) {
      return map.has(key) ? map.get(key) : null
    },
    set(key, value) {
      map.set(key, value)
    },
    remove(key) {
      map.delete(key)
    },
    keys() {
      return [...map.keys()]
    },
  }
}

/**
 * 端上实现。uni 的同步存储在不同平台上对对象/数组的处理差别很大
 * （小程序会保留对象，App 端某些版本只支持字符串），所以这里统一按 JSON 字符串存，
 * 读取时兼容"已经是对象"的情况。
 */
export function createUniStorage() {
  const hasUni = typeof uni !== 'undefined' && typeof uni.getStorageSync === 'function'
  if (!hasUni) return createMemoryStorage()

  return {
    get(key) {
      try {
        const raw = uni.getStorageSync(key)
        if (raw === '' || raw === undefined || raw === null) return null
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw)
          } catch {
            return raw
          }
        }
        return raw
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        uni.setStorageSync(key, JSON.stringify(value))
      } catch {
        /* 存储写失败不应让界面崩掉，读取侧会退化为默认值 */
      }
    },
    remove(key) {
      try {
        uni.removeStorageSync(key)
      } catch {
        /* 同上 */
      }
    },
  }
}

/** 按运行环境挑一个实现。 */
export function createStorage() {
  return createUniStorage()
}
