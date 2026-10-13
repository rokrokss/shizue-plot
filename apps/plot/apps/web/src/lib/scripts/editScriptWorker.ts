/**
 * The worker the chat's `editinput`/`editoutput` regex scripts run in
 * (`editScriptRunner.ts` starts it and ends it; `editScriptJob.ts` is what it
 * does). Its own bundle, with the trigger language's CBS evaluator in it.
 */

import { serveEditJobs, type EditWorkerScope } from './editScriptJob';

serveEditJobs(self as unknown as EditWorkerScope);
