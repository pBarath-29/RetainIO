import React, { useState } from 'react';
import { Account } from '../types';
import { Activity, Smile } from 'lucide-react';

interface MonthlyDataPoint {
  month: string;
  year: number;
  mrrRiskK: number; // in $K
  avgRiskPct: number; // in %
}

interface PortfolioTrajectoryChartsProps {
  accounts: Account[];
  // Real monthly aggregate from server.ts's computePortfolioTrend() — the
  // average of each company's own real monthly fusion score average, not
  // invented. Empty until at least one real daily snapshot has run.
  monthlyData?: MonthlyDataPoint[];
}

export const PortfolioTrajectoryCharts: React.FC<PortfolioTrajectoryChartsProps> = ({ accounts, monthlyData = [] }) => {
  const [hoveredMonthIndex, setHoveredMonthIndex] = useState<number | null>(null);

  // Derive sentiment counts dynamically from current accounts. The trained
  // sentiment model only ever outputs 3 classes — Frustrated / Neutral /
  // Satisfied — see types.ts's SentimentType.
  const positiveCount = accounts.filter(a => a.sentimentClassification === 'Satisfied').length;
  const neutralCount = accounts.filter(a => a.sentimentClassification === 'Neutral').length;
  const negativeCount = accounts.filter(a => a.sentimentClassification === 'Frustrated').length;

  const totalSentimentCount = positiveCount + neutralCount + negativeCount || 1;

  if (monthlyData.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 text-sm text-slate-500">
        Not enough historical data yet to chart a portfolio trend — this fills in as fusion scores accumulate over time.
      </div>
    );
  }

  // Chart layout dimensions
  const svgWidth = 550;
  const svgHeight = 220;
  const paddingLeft = 50;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 35;

  const graphWidth = svgWidth - paddingLeft - paddingRight;
  const graphHeight = svgHeight - paddingTop - paddingBottom;

  // Max value for MRR Risk ($K) Y-Axis
  const maxY = 140;

  // Helper to calculate SVG X position
  const getX = (index: number) => {
    return paddingLeft + (index / Math.max(1, monthlyData.length - 1)) * graphWidth;
  };

  // Helper to calculate SVG Y position for MRR Risk ($K)
  const getYMrr = (val: number) => {
    return paddingTop + graphHeight - (val / maxY) * graphHeight;
  };

  // Helper to calculate SVG Y position for Avg Risk % (scaled so 100% maps near a quarter of the scale for clear visibility)
  const getYRisk = (valPct: number) => {
    // Map 0 - 100% to lower portion of chart (0 to a quarter of maxY on MRR scale)
    const scaledVal = (valPct / 100) * 35; // maps 0-100% to 0-35 on $K scale
    return paddingTop + graphHeight - (scaledVal / maxY) * graphHeight;
  };

  // Generate smooth cubic bezier SVG path string for array of points
  const generateSmoothPath = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return '';
    let path = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const cpX1 = p0.x + (p1.x - p0.x) / 2;
      const cpY1 = p0.y;
      const cpX2 = p0.x + (p1.x - p0.x) / 2;
      const cpY2 = p1.y;

      path += ` C ${cpX1.toFixed(1)},${cpY1.toFixed(1)} ${cpX2.toFixed(1)},${cpY2.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
    }
    return path;
  };

  const mrrPoints = monthlyData.map((d, i) => ({ x: getX(i), y: getYMrr(d.mrrRiskK) }));
  const riskPoints = monthlyData.map((d, i) => ({ x: getX(i), y: getYRisk(d.avgRiskPct) }));

  const mrrLinePath = generateSmoothPath(mrrPoints);
  const mrrAreaPath = `${mrrLinePath} L ${mrrPoints[mrrPoints.length - 1].x.toFixed(1)},${(paddingTop + graphHeight).toFixed(1)} L ${mrrPoints[0].x.toFixed(1)},${(paddingTop + graphHeight).toFixed(1)} Z`;

  const riskLinePath = generateSmoothPath(riskPoints);

  // Y-axis grid ticks
  const yTicks = [140, 105, 70, 35, 0];

  // Donut Chart calculations for Sentiment
  const donutRadius = 55;
  const donutStrokeWidth = 18;
  const donutCenter = 75;
  const circumference = 2 * Math.PI * donutRadius;

  // Ratios
  const posRatio = positiveCount / totalSentimentCount;
  const neuRatio = neutralCount / totalSentimentCount;
  const negRatio = negativeCount / totalSentimentCount;

  // Stroke Dash arrays
  const gap = totalSentimentCount > 1 ? 4 : 0;
  const posDash = Math.max(0, posRatio * circumference - gap);
  const neuDash = Math.max(0, neuRatio * circumference - gap);
  const negDash = Math.max(0, negRatio * circumference - gap);

  const posOffset = 0;
  const neuOffset = -(posRatio * circumference);
  const negOffset = -((posRatio + neuRatio) * circumference);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      
      {/* 1. Portfolio Churn Risk Trajectory Card (8 Cols) */}
      <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
        
        {/* Header with Title & Legend */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-1">
          <div className="space-y-0.5">
            <div className="flex items-center space-x-2">
              <Activity className="w-4 h-4 text-indigo-600 shrink-0" />
              <h3 className="font-bold text-slate-900 text-sm tracking-tight">
                Portfolio Churn Risk Trajectory (6-Month Trend)
              </h3>
            </div>
            <p className="text-xs text-slate-500">
              Average churn probability vs MRR at risk ($K) over time
            </p>
          </div>

          {/* Legend Bullets */}
          <div className="flex items-center space-x-4 text-xs font-semibold shrink-0">
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block" />
              <span className="text-indigo-700">Avg Risk %</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 inline-block" />
              <span className="text-cyan-600">MRR Risk ($K)</span>
            </div>
          </div>
        </div>

        {/* Chart ViewBox SVG */}
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-auto overflow-visible select-none"
            onMouseLeave={() => setHoveredMonthIndex(null)}
          >
            <defs>
              {/* Cyan Gradient for MRR Area */}
              <linearGradient id="cyanAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Horizontal Y-Axis Gridlines & Labels */}
            {yTicks.map((tickVal) => {
              const yPos = paddingTop + graphHeight - (tickVal / maxY) * graphHeight;
              return (
                <g key={tickVal}>
                  <line
                    x1={paddingLeft}
                    y1={yPos}
                    x2={svgWidth - paddingRight}
                    y2={yPos}
                    stroke="#f1f5f9"
                    strokeWidth="1"
                  />
                  <text
                    x={paddingLeft - 8}
                    y={yPos + 4}
                    textAnchor="end"
                    className="text-[10px] fill-slate-400 font-mono"
                  >
                    {tickVal}
                  </text>
                </g>
              );
            })}

            {/* Cyan Area Fill under MRR Line */}
            <path d={mrrAreaPath} fill="url(#cyanAreaGradient)" />

            {/* Cyan MRR Line */}
            <path
              d={mrrLinePath}
              fill="none"
              stroke="#06b6d4"
              strokeWidth="2.5"
              strokeLinecap="round"
            />

            {/* Violet Avg Risk Line */}
            <path
              d={riskLinePath}
              fill="none"
              stroke="#6366f1"
              strokeWidth="2"
              strokeLinecap="round"
            />

            {/* X-Axis Month Labels & Interactive Vertical Hover Guides */}
            {monthlyData.map((d, idx) => {
              const xPos = getX(idx);
              const isHovered = hoveredMonthIndex === idx;

              return (
                <g key={d.month} className="cursor-pointer" onMouseEnter={() => setHoveredMonthIndex(idx)}>
                  {/* Vertical Guide Line when hovered */}
                  {isHovered && (
                    <line
                      x1={xPos}
                      y1={paddingTop}
                      x2={xPos}
                      y2={paddingTop + graphHeight}
                      stroke="#cbd5e1"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                    />
                  )}

                  {/* X-Axis Month Label */}
                  <text
                    x={xPos}
                    y={svgHeight - 10}
                    textAnchor="middle"
                    className={`text-[11px] font-semibold ${isHovered ? 'fill-slate-900 font-bold' : 'fill-slate-500'}`}
                  >
                    {d.month}
                  </text>

                  {/* Cyan Point Dot */}
                  <circle
                    cx={xPos}
                    cy={getYMrr(d.mrrRiskK)}
                    r={isHovered ? '5' : '3'}
                    fill="#06b6d4"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />

                  {/* Violet Point Dot */}
                  <circle
                    cx={xPos}
                    cy={getYRisk(d.avgRiskPct)}
                    r={isHovered ? '4.5' : '2.5'}
                    fill="#6366f1"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />

                  {/* Invisible broad hover trigger column */}
                  <rect
                    x={xPos - graphWidth / (monthlyData.length * 2)}
                    y={paddingTop}
                    width={graphWidth / monthlyData.length}
                    height={graphHeight}
                    fill="transparent"
                  />
                </g>
              );
            })}
          </svg>

          {/* Interactive Tooltip Card when hovering a month */}
          {hoveredMonthIndex !== null && (
            <div
              className="absolute z-10 top-2 bg-slate-900 text-white p-2.5 rounded-lg shadow-lg text-xs space-y-1 pointer-events-none transition-all duration-150 w-max max-w-40"
              style={{
                left: `${(getX(hoveredMonthIndex) / svgWidth) * 100}%`,
                transform:
                  hoveredMonthIndex === 0
                    ? 'translateX(0%)'
                    : hoveredMonthIndex === monthlyData.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
              }}
            >
              <div className="font-bold border-b border-slate-700 pb-1 text-slate-300">
                {monthlyData[hoveredMonthIndex].month} {monthlyData[hoveredMonthIndex].year} Snapshot
              </div>
              <div className="flex items-center justify-between space-x-3 text-cyan-400 font-mono text-[11px]">
                <span>MRR at Risk:</span>
                <span className="font-bold">${monthlyData[hoveredMonthIndex].mrrRiskK}k</span>
              </div>
              <div className="flex items-center justify-between space-x-3 text-indigo-300 font-mono text-[11px]">
                <span>Avg Churn Risk:</span>
                <span className="font-bold">{monthlyData[hoveredMonthIndex].avgRiskPct}%</span>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* 2. Customer Sentiment Health Donut Card (4 Cols) */}
      <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs flex flex-col justify-between">
        
        {/* Header */}
        <div className="space-y-0.5">
          <div className="flex items-center space-x-2">
            <Smile className="w-4 h-4 text-emerald-600 shrink-0" />
            <h3 className="font-bold text-slate-900 text-sm tracking-tight">
              Customer Sentiment Health
            </h3>
          </div>
          <p className="text-xs text-slate-500">
            NLP Mood categorization across customer communications
          </p>
        </div>

        {/* Donut Chart Center */}
        <div className="flex justify-center items-center my-2">
          <div className="relative w-40 h-40 flex items-center justify-center">
            <svg viewBox="0 0 150 150" className="w-full h-full transform -rotate-90 overflow-visible">
              
              {/* Background Track Circle */}
              <circle
                cx={donutCenter}
                cy={donutCenter}
                r={donutRadius}
                fill="none"
                stroke="#f1f5f9"
                strokeWidth={donutStrokeWidth}
              />

              {/* Positive Segment (Green) */}
              {positiveCount > 0 && (
                <circle
                  cx={donutCenter}
                  cy={donutCenter}
                  r={donutRadius}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={donutStrokeWidth}
                  strokeDasharray={`${posDash} ${circumference}`}
                  strokeDashoffset={posOffset}
                  strokeLinecap="round"
                />
              )}

              {/* Neutral Segment (Amber) */}
              {neutralCount > 0 && (
                <circle
                  cx={donutCenter}
                  cy={donutCenter}
                  r={donutRadius}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={donutStrokeWidth}
                  strokeDasharray={`${neuDash} ${circumference}`}
                  strokeDashoffset={neuOffset}
                  strokeLinecap="round"
                />
              )}

              {/* Negative Segment (Red / Coral) */}
              {negativeCount > 0 && (
                <circle
                  cx={donutCenter}
                  cy={donutCenter}
                  r={donutRadius}
                  fill="none"
                  stroke="#f43f5e"
                  strokeWidth={donutStrokeWidth}
                  strokeDasharray={`${negDash} ${circumference}`}
                  strokeDashoffset={negOffset}
                  strokeLinecap="round"
                />
              )}
            </svg>

            {/* Donut Inner Label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
              <span className="text-2xl font-black text-slate-900 leading-none">
                {totalSentimentCount}
              </span>
              <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mt-0.5">
                Signals
              </span>
            </div>
          </div>
        </div>

        {/* Bottom Metrics Bar */}
        <div className="pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
          
          <div className="space-y-0.5">
            <div className="text-lg font-bold text-emerald-600">{positiveCount}</div>
            <div className="text-[11px] font-medium text-slate-600">Positive</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-lg font-bold text-slate-600">{neutralCount}</div>
            <div className="text-[11px] font-medium text-slate-600">Neutral</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-lg font-bold text-rose-600">{negativeCount}</div>
            <div className="text-[11px] font-medium text-slate-600">Negative</div>
          </div>

        </div>

      </div>

    </div>
  );
};
