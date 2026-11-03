import type React from "react";
import { AbsoluteFill } from "remotion";
import { body, c, CARD, head, mono } from "../brand";

export const BANNER = { fps: 30, width: 2560, height: 1440 } as const;
export const SAFE_ZONE = { width: 1546, height: 423 } as const;

/**
 * Personal developer YouTube channel banner for @DerickPayneDev (D10 T01 §10).
 * 2560 x 1440 canvas with all typography, badges and marks strictly inside the
 * centred 1546 x 423 TV/desktop/mobile safe zone. Unrelated to IsItLegit so the
 * channel header is permanent across future engineering series.
 */
export const ChannelBanner: React.FC = () => {
  const pills = [
    "AI Engineering",
    "Systems Architecture",
    "Production Builds",
  ];
  const stack = [
    "Multi-Agent Engineering",
    "Model Fine-Tuning & Evals",
    "Full-Stack Systems",
  ];

  return (
    <AbsoluteFill
      style={{
        background: "#08090D",
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      {/* Full-canvas TV background ambience */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle 1100px at 72% 46%, rgba(242, 104, 34, 0.18), transparent 70%), radial-gradient(circle 900px at 26% 54%, rgba(56, 189, 248, 0.12), transparent 68%)",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 82% 76% at 50% 50%, transparent 45%, rgba(4, 5, 8, 0.9) 100%)",
        }}
      />

      {/* Centred 1546 x 423 safe zone for desktop, tablet and mobile headers */}
      <div
        style={{
          width: SAFE_ZONE.width,
          height: SAFE_ZONE.height,
          boxSizing: "border-box",
          padding: "36px 56px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "rgba(15, 17, 23, 0.86)",
          border: `2px solid ${c["line-strong"]}`,
          borderRadius: 28,
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.65)",
        }}
      >
        {/* Left: Monogram + Name + Handle + Core Pillars */}
        <div style={{ display: "flex", alignItems: "center", gap: 38 }}>
          <div
            style={{
              width: 148,
              height: 148,
              borderRadius: 26,
              background: "linear-gradient(135deg, #F26822 0%, #C2410C 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 12px 36px rgba(242, 104, 34, 0.32)",
              border: "2px solid rgba(255, 255, 255, 0.18)",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                ...head,
                fontSize: 68,
                fontWeight: 800,
                color: "#FFFFFF",
                letterSpacing: -2,
              }}
            >
              DP
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <span
                style={{
                  ...head,
                  fontSize: 66,
                  fontWeight: 800,
                  color: c.ink,
                  lineHeight: 1,
                  letterSpacing: -1.2,
                }}
              >
                Derick Payne
              </span>
              <span
                style={{
                  ...mono,
                  fontSize: 24,
                  fontWeight: 600,
                  color: c.orange,
                  background: `${CARD}`,
                  border: `1.5px solid ${c.orange}`,
                  borderRadius: 999,
                  padding: "6px 18px",
                }}
              >
                @DerickPayneDev
              </span>
            </div>

            <div
              style={{
                ...body,
                fontSize: 30,
                fontWeight: 600,
                color: c["ink-2"],
                letterSpacing: 0.2,
              }}
            >
              {pills.join("  ·  ")}
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
              {stack.map((item) => (
                <div
                  key={item}
                  style={{
                    ...mono,
                    fontSize: 19,
                    fontWeight: 500,
                    color: c.muted,
                    background: "rgba(255, 255, 255, 0.04)",
                    border: `1px solid ${c.line}`,
                    borderRadius: 10,
                    padding: "6px 14px",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Architectural telemetry card inside safe zone */}
        <div
          style={{
            width: 340,
            background: "rgba(9, 10, 15, 0.9)",
            border: `1.5px solid ${c.line}`,
            borderRadius: 20,
            padding: "24px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              ...mono,
              fontSize: 17,
              fontWeight: 700,
              color: c.orange,
              letterSpacing: 1.2,
            }}
          >
            DEEP TECHNICAL LOGS
          </div>
          <div
            style={{
              ...body,
              fontSize: 22,
              lineHeight: 1.35,
              color: c.ink,
              fontWeight: 600,
            }}
          >
            Real codebases, measured benchmarks and end-to-end builds.
          </div>
          <div
            style={{
              ...mono,
              fontSize: 17,
              color: c.muted,
              borderTop: `1px solid ${c.line}`,
              paddingTop: 10,
            }}
          >
            rizonetech.com
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
