import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import s from '../onboarding/scenes/scenes.module.css';

/**
 * How the README shows a scene: the onboarding's own scene, tilted in 3D like the Parallel scene.
 * The camera holds still, or moves only to follow the story (a camera that never stops changes
 * every pixel of every frame, and the GIFs grow past what GitHub will show).
 */
export interface Pose {
  /** Tilt toward you (rx), sideways (ry), a touch of roll (rz), in degrees; and a slide (x, px). */
  readonly rx: number;
  readonly ry: number;
  readonly rz?: number;
  readonly x?: number;
}

export interface Staging {
  /** Where the camera sits. */
  readonly pose?: Pose;
  /** Or where it looks over time: poses at times (ms), held between, round and round every `period` ms. */
  readonly shots?: { readonly period: number; readonly at: readonly (readonly [number, Pose])[] };
  /** Depth for parts of the scene instead of tilting all of it. */
  readonly css?: string;
}

const LEFT: Pose = { rx: 14, ry: 13, rz: -1, x: 55 };
const RIGHT: Pose = { rx: 14, ry: -13, rz: 1, x: -55 };

/** Parallel is tilted already, so it isn't here. */
export const STAGING: Record<string, Staging> = {
  tables: { pose: { rx: 12, ry: -14, rz: 1.2 } },
  // The camera turns to whoever is doing something (Friends' beats): your Mac while yours works and
  // asks, Ada's while she allows it and her agent works, yours again when the result comes back.
  friends: {
    shots: {
      period: 11_400,
      at: [
        [0, LEFT],
        [1300, LEFT],
        [2200, RIGHT],
        [8000, RIGHT],
        [8900, LEFT],
        [11_400, LEFT],
      ],
    },
  },
  // Your chat on the left, Scratch filling up on the right: turned toward Scratch.
  scratch: { pose: { rx: 12, ry: -13, rz: 1 } },
  // The Share sheet opens at the top right.
  together: { pose: { rx: 12, ry: -12, rz: 1 } },
  sentinel: { pose: { rx: 12, ry: 12, rz: -1 } },
  // Your app and phone on the left, your computers on the right: turned toward the computers, where the work goes.
  machines: { pose: { rx: 14, ry: -14, rz: 1 } },
  earnings: { pose: { rx: 14, ry: 16, rz: -1 } },
  // Only the cards tilt; the size beside them reads straight on.
  archive: { css: `.${s.archive} { transform-style: preserve-3d; } .${s.pile} { transform-style: preserve-3d; transform: rotateX(16deg) rotateY(22deg) rotateZ(-2deg); }` },
};

const transformOf = (p: Pose): string => `translateX(${p.x ?? 0}px) rotateX(${p.rx}deg) rotateY(${p.ry}deg) rotateZ(${p.rz ?? 0}deg)`;

export function Staged({ staging, children }: { readonly staging: Staging; readonly children: ReactNode }) {
  const box = { width: '100%', height: '100%', display: 'grid', placeItems: 'center' } as const;
  const { shots, pose } = staging;
  return (
    <div style={{ ...box, perspective: 1500 }}>
      {staging.css ? <style>{staging.css}</style> : null}
      {shots ? (
        <motion.div
          style={{ ...box, transformStyle: 'preserve-3d' }}
          initial={{ x: shots.at[0]![1].x ?? 0, rotateX: shots.at[0]![1].rx, rotateY: shots.at[0]![1].ry, rotateZ: shots.at[0]![1].rz ?? 0 }}
          animate={{
            x: shots.at.map(([, p]) => p.x ?? 0),
            rotateX: shots.at.map(([, p]) => p.rx),
            rotateY: shots.at.map(([, p]) => p.ry),
            rotateZ: shots.at.map(([, p]) => p.rz ?? 0),
          }}
          transition={{ duration: shots.period / 1000, times: shots.at.map(([t]) => t / shots.period), ease: 'easeInOut', repeat: Infinity }}
        >
          {children}
        </motion.div>
      ) : (
        <div style={{ ...box, transformStyle: 'preserve-3d', ...(pose ? { transform: transformOf(pose) } : {}) }}>{children}</div>
      )}
    </div>
  );
}
