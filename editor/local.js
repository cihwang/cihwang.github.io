// 쓰던 글의 기기 안 저장본. GitHub에 올리기 전에도 글이 사라지지 않게 하는 마지막 안전망이다.
import { LOCAL_PREFIX } from './config.js';

// 샌드박스·일부 사생활 보호 모드에서는 localStorage 속성을 읽기만 해도 던진다.
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 기기 안 저장소를 만든다. 키 앞에는 `LOCAL_PREFIX`를 붙여 다른 값과 섞이지 않게 한다.
 * 저장 데이터 모양: `{ meta, body, draftPath, draftSha, blogPath, blogSha, savedAt, remoteSavedAt }`.
 * @param {Storage|null} [storage] 기본은 브라우저 `localStorage`. 쓸 수 없으면 null로 두고 save·clear가 던진다.
 */
export function createLocal(storage = defaultStorage()) {
  return {
    /**
     * 저장한다. 저장 공간이 꽉 찼거나 막혀 있으면 던진다 — 저장된 척하지 않는다.
     * @param {string} key 문서 키(`draftPath`, `blogPath`, 또는 `new:<랜덤>`)
     * @throws {Error} 저장하지 못했을 때. 원래 오류는 `cause`.
     */
    save(key, data) {
      try {
        storage.setItem(LOCAL_PREFIX + key, JSON.stringify(data));
      } catch (e) {
        throw new Error(`기기에 저장하지 못했어요. 저장 공간이 꽉 찼거나 막혀 있어요. (${key})`, { cause: e });
      }
    },

    /**
     * 읽는다. 없거나, JSON이 깨졌거나, 저장소를 읽을 수 없으면 null.
     * 깨진 저장본은 손으로 살릴 수 있게 지우지 않는다.
     */
    load(key) {
      let raw;
      try {
        raw = storage.getItem(LOCAL_PREFIX + key);
      } catch {
        // 읽을 수 없는 저장소에는 되살릴 저장본도 없다.
        return null;
      }
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    /**
     * 지운다. 지우지 못하면 던진다(남은 옛 저장본이 나중에 "더 최근 내용"으로 보일 수 있다).
     * @throws {Error} 저장소를 쓸 수 없을 때. 원래 오류는 `cause`.
     */
    clear(key) {
      try {
        storage.removeItem(LOCAL_PREFIX + key);
      } catch (e) {
        throw new Error(`기기 저장본을 지우지 못했어요. (${key})`, { cause: e });
      }
    },

    /** 이 에디터가 저장한 키들(접두어를 뗀 것). 저장소를 읽을 수 없으면 빈 배열. */
    keys() {
      const out = [];
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const k = storage.key(i);
          if (k?.startsWith(LOCAL_PREFIX)) out.push(k.slice(LOCAL_PREFIX.length));
        }
      } catch {
        return [];
      }
      return out;
    },
  };
}
