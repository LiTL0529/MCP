import { aggregateInsights } from "./insights.js";
import { creativeMonthlyTrend } from "./creative.js";
import type { UserContext } from "./types.js";

// Real "整体数据" overview, computed in the database and filtered to what the
// caller can access — replaces the workbench's localStorage mock charts.
export async function getOverviewStats(user: UserContext) {
  const [byCategory, byMonth, byStatus, byType, cvTrend] = await Promise.all([
    aggregateInsights(user, { groupBy: "category" }),
    aggregateInsights(user, { groupBy: "month" }),
    aggregateInsights(user, { groupBy: "status" }),
    aggregateInsights(user, { groupBy: "type" }),
    creativeMonthlyTrend(user),
  ]);
  const creativeTotal = cvTrend.reduce((sum, b) => sum + b.count, 0);
  return {
    insights: {
      total: byCategory.total,
      by_category: byCategory.buckets,
      by_month: byMonth.buckets,
      by_status: byStatus.buckets,
      by_type: byType.buckets,
    },
    creative: { total: creativeTotal, by_month: cvTrend },
  };
}
