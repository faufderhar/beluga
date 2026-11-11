import type { Mesh } from '../../net/mesh/mesh.js';
import type { BoardLinks } from './service.js';

/** Friends' links, as the swap sees them. */
export function meshBoardLinks(mesh: Mesh): BoardLinks {
  return {
    linked: () => mesh.linkedFriends(),
    send: (peerId, payload) => mesh.sendStats(peerId, payload),
    onFrame: (fn) => {
      mesh.on('stats', fn);
      return () => void mesh.off('stats', fn);
    },
    onLink: (fn) => {
      mesh.on('link', fn);
      return () => void mesh.off('link', fn);
    },
  };
}
