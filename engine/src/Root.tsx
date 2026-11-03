import React from 'react';
import { Composition } from 'remotion';
import { Sketch } from './Sketch';
import { timelines } from '../build/compositions.generated';

// 成片列表由 compiler/gen-compositions.mjs 根据 build/ 里的时间线自动生成
export const Root: React.FC = () => (
  <>
    {timelines.map((tl) => (
      <Composition
        key={tl.id}
        id={tl.id}
        component={Sketch}
        durationInFrames={tl.durationInFrames}
        fps={tl.fps}
        width={tl.canvas.w}
        height={tl.canvas.h}
        defaultProps={{ tl, inkMode: 'mono' as const }}
      />
    ))}
  </>
);
