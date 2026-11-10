import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";

import { voiceAudio } from "./controller";

// Cyan through violet, the web glow's hue range, each drifting at its own pace.
const LAYERS = [
  { color: "#22d3ee", left: "-18%", width: "70%", speed: 0.9, phase: 0.4 },
  { color: "#38bdf8", left: "8%", width: "62%", speed: 1.3, phase: 2.1 },
  { color: "#818cf8", left: "30%", width: "58%", speed: 1.1, phase: 4.2 },
  { color: "#a78bfa", left: "52%", width: "64%", speed: 0.7, phase: 1.3 },
  { color: "#e879f9", left: "70%", width: "48%", speed: 1.5, phase: 3.3 },
] as const;
const LEVEL_SAMPLE_MS = 33;

/** An audio-reactive aurora along the panel's bottom edge that moves only while Voice is live. */
export function VoiceGlow(props: { readonly live: boolean }) {
  const reduceMotion = useReducedMotion();
  const animated = props.live && !reduceMotion;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {animated ? <LiveGlow /> : <StillGlow />}
    </View>
  );
}

function StillGlow() {
  const clock = useSharedValue(0);
  const energy = useSharedValue(0);
  return <GlowLayers clock={clock} energy={energy} />;
}

function LiveGlow() {
  const clock = useSharedValue(0);
  const energy = useSharedValue(0);
  useFrameCallback((frame) => {
    clock.set(clock.get() + (frame.timeSincePreviousFrame ?? 16) / 1000);
  }, true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the native audio owner's loudness for the UI thread while Voice is live
  useEffect(() => {
    const timer = setInterval(() => {
      energy.set(withTiming(voiceAudio.level(), { duration: LEVEL_SAMPLE_MS * 3 }));
    }, LEVEL_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [energy]);
  return <GlowLayers clock={clock} energy={energy} />;
}

function GlowLayers(props: {
  readonly clock: SharedValue<number>;
  readonly energy: SharedValue<number>;
}) {
  return (
    <>
      {LAYERS.map((layer, index) => (
        <GlowLayer key={layer.color} index={index} {...props} />
      ))}
    </>
  );
}

function GlowLayer(props: {
  readonly index: number;
  readonly clock: SharedValue<number>;
  readonly energy: SharedValue<number>;
}) {
  const layer = LAYERS[props.index]!;
  const { clock, energy } = props;
  const style = useAnimatedStyle(() => {
    const t = clock.get() * layer.speed + layer.phase;
    const level = energy.get();
    return {
      opacity: 0.5 + 0.5 * level,
      transform: [
        { translateX: Math.sin(t * 0.45) * (10 + 26 * level) },
        { scaleY: 0.55 + 0.08 * Math.sin(t) + level * (0.5 + 0.25 * Math.sin(t * 1.7)) },
      ],
    };
  });
  const id = `voice-glow-${props.index}`;
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          bottom: 0,
          left: layer.left,
          width: layer.width,
          height: "100%",
          transformOrigin: "50% 100%",
        },
        style,
      ]}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={id} cx="50" cy="100" rx="50" ry="100" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={layer.color} stopOpacity={0.34} />
            <Stop offset="0.55" stopColor={layer.color} stopOpacity={0.12} />
            <Stop offset="1" stopColor={layer.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="100" rx="50" ry="100" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}
