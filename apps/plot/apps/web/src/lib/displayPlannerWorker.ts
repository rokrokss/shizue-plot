/**
 * The worker a card's display scripts run in (`displayPlanner.ts` starts it and
 * ends it; `displayPlanJob.ts` is what it does). Its own bundle, with the CBS
 * engine in it, since RisuAI reads each script's output as CBS before the next
 * script matches.
 */

import { serveDisplayPlans, type PlanWorkerScope } from './displayPlanJob';

serveDisplayPlans(self as unknown as PlanWorkerScope);
