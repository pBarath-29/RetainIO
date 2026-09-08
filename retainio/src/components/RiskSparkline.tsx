import React from 'react';
import { TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';

interface RiskSparklineProps {
  history?: number[];
  trend: 'increasing' | 'stable' | 'decreasing';
  riskCategory: 'High Risk' | 'Medium Risk' | 'Low Risk';
  currentScore: number;
}

export const RiskSparkline: React.FC<RiskSparklineProps> = ({
  history = [50, 50, 50, 50, 50, 50],
  trend,
  riskCategory,
  currentScore
}) => {
  if (!history || history.length === 0) return null;

  const width = 110;
  const height = 30;
  const padding = 4;

  const firstScore = history[0];
  const lastScore = history[history.length - 1];
  const delta = lastScore - firstScore;

  // Find min and max for auto-scaling sparkline vertical bounds
  const minVal = Math.max(0, Math.min(...history) - 5);
  const maxVal = Math.min(100, Math.max(...history) + 5);
  const range = maxVal - minVal || 1;

  // Calculate coordinates. Real gaps (a month with no snapshots) can now
  // leave a short history, so guard the single-point case explicitly rather
  // than dividing by zero.
  const points = history.map((val, idx) => {
    const x = padding + (idx / Math.max(1, history.length - 1)) * (width - padding * 2);
    // Invert Y axis for SVG (0 is top)
    const y = height - padding - ((val - minVal) / range) * (height - padding * 2);
    return { x, y, value: val, index: idx };
  });

  // Polyline points string
  const pointsString = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Area path string for gradient under curve
  const areaString = `M ${points[0].x.toFixed(1)} ${height - 2} L ${pointsString} L ${points[points.length - 1].x.toFixed(1)} ${height - 2} Z`;

  // Determine stroke & gradient colors
  const isIncreasing = trend === 'increasing' || delta > 0;
  const isDecreasing = trend === 'decreasing' || delta < 0;

  const strokeColor = isIncreasing
    ? '#dc2626' // Red
    : isDecreasing
    ? '#16a34a' // Green
    : '#475569'; // Slate

  const gradientId = `sparkline-grad-${Math.random().toString(36).substring(2, 9)}`;

  return (
    <div className="flex items-center space-x-3 bg-slate-50/80 p-2.5 rounded-lg border border-slate-200/80">
      <div className="flex-1 space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-slate-500 font-medium flex items-center space-x-1">
            <Activity className="w-3 h-3 text-slate-400" />
            <span>6-Mo Trend</span>
          </span>

          {/* Trend Badge */}
          <span
            className={`font-bold flex items-center space-x-0.5 text-[10px] px-1.5 py-0.5 rounded ${
              isIncreasing
                ? 'bg-red-100 text-red-800 border border-red-200'
                : isDecreasing
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                : 'bg-slate-200 text-slate-700'
            }`}
          >
            {isIncreasing ? (
              <>
                <TrendingUp className="w-3 h-3 text-red-700 shrink-0" />
                <span>+{delta}%</span>
              </>
            ) : isDecreasing ? (
              <>
                <TrendingDown className="w-3 h-3 text-emerald-700 shrink-0" />
                <span>{delta}%</span>
              </>
            ) : (
              <>
                <Minus className="w-3 h-3 text-slate-600 shrink-0" />
                <span>Stable</span>
              </>
            )}
          </span>
        </div>

        {/* SVG Sparkline Container */}
        <div className="relative pt-1">
          <svg
            width={width}
            height={height}
            className="overflow-visible"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity={0.25} />
                <stop offset="100%" stopColor={strokeColor} stopOpacity={0.0} />
              </linearGradient>
            </defs>

            {/* Area Fill */}
            <path d={areaString} fill={`url(#${gradientId})`} />

            {/* Sparkline Stroke Line */}
            <polyline
              fill="none"
              stroke={strokeColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={pointsString}
            />

            {/* Last Point Marker */}
            <circle
              cx={points[points.length - 1].x}
              cy={points[points.length - 1].y}
              r="3"
              fill={strokeColor}
              stroke="#ffffff"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      </div>
    </div>
  );
};
