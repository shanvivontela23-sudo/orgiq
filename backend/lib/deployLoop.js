'use strict';

/**
 * deployLoop.js
 *
 * The deploy safety system. Claude generates — OrgIQ validates, dry-runs,
 * repairs deterministic issues, and only then does real deploy.
 *
 * Flow:
 *   1. Local preflight (no API call)
 *   2. Apply deterministic fixes
 *   3. Salesforce checkOnly deploy (dry run)
 *   4. Classify all errors
 *   5. Apply deterministic fixes for classified errors
 *   6. checkOnly again (if any fixes were applied)
 *   7. If checkOnly passes → real deploy (if requested)
 *   8. Collect questions for anything that needs human input
 */

const { runPreflight }          = require('./preflightValidator');
const { classifyDeployResult }  = require('./errorClassifier');
const { deployArtifact, buildDeployPackage, metadataDeployCheckOnly } = require('./metadataDeployer');
const { recordNewPattern, incrementHitCount } = require('./knowledgeStore');

/**
 * Run the full deploy loop.
 *
 * @param {object} params
 * @param {string} params.artifactXml     - Generated XML
 * @param {string} params.artifactType    - 'flow' | 'validationRule' | etc.
 * @param {string} params.apiName         - API name
 * @param {object} params.orgSchema       - Org schema context (for field validation)
 * @param {object} params.sfClient        - Authenticated SalesforceClient
 * @param {boolean} params.realDeploy     - Whether to do the real deploy after dry run passes
 * @param {boolean} params.activate       - Activate after deploy (flows)
 * @returns {DeployLoopResult}
 */
async function runDeployLoop({
  artifactXml,
  artifactType,
  apiName,
  orgSchema = {},
  sfClient,
  realDeploy = false,
  activate   = false,
}) {
  const log = [];
  const push = (step, status, detail) => log.push({ step, status, detail, ts: Date.now() });

  // ── STEP 1: Local preflight ───────────────────────────────────────────────
  push('preflight', 'running', 'Running local preflight checks...');
  const preflight = runPreflight(artifactXml, artifactType, apiName, orgSchema);

  let workingXml    = preflight.repairedXml;
  let workingName   = preflight.repairedApiName || apiName;

  if (preflight.appliedFixes.length > 0) {
    push('preflight', 'fixed', `Auto-fixed: ${preflight.appliedFixes.join(', ')}`);
  }

  if (!preflight.passed) {
    push('preflight', 'failed', `${preflight.errors.length} error(s) found`);
    // Don't proceed to deploy if preflight has hard errors that we couldn't fix
    const unfixed = preflight.errors.filter(e => !e.fix);
    if (unfixed.length > 0) {
      return {
        success:     false,
        stage:       'preflight',
        preflight,
        dryRun:      null,
        classified:  [],
        questions:   unfixed.map(e => e.message),
        log,
        finalXml:    workingXml,
        finalName:   workingName,
      };
    }
  } else {
    push('preflight', 'passed', `${preflight.warnings.length} warning(s)`);
  }

  // ── STEP 2: Salesforce dry run (checkOnly) ────────────────────────────────
  push('dryrun', 'running', 'Running Salesforce checkOnly deploy...');

  let dryRunResult;
  try {
    dryRunResult = await deployArtifact({
      artifactXml:  workingXml,
      artifactType,
      apiName:      workingName,
      sfClient,
      checkOnly:    true,
      activate:     false,
    });
  } catch (err) {
    push('dryrun', 'error', err.message);
    return {
      success:    false,
      stage:      'dryrun',
      preflight,
      dryRun:     { success: false, error: { message: err.message } },
      classified: [],
      questions:  [`Deploy service error: ${err.message}`],
      log,
      finalXml:   workingXml,
      finalName:  workingName,
    };
  }

  // ── STEP 3: Classify errors from dry run ─────────────────────────────────
  const classified = classifyDeployResult(dryRunResult, artifactType, workingName);

  // Track patterns in knowledge store
  for (const c of classified) {
    if (c.category === 'UNKNOWN') {
      await recordNewPattern(c.rawError, artifactType);
    } else {
      await incrementHitCount(c.category, artifactType).catch(() => {});
    }
  }

  if (dryRunResult.success) {
    push('dryrun', 'passed', 'Salesforce dry run passed');

    if (!realDeploy) {
      return {
        success:    true,
        stage:      'dryrun',
        preflight,
        dryRun:     dryRunResult,
        classified: [],
        questions:  [],
        log,
        finalXml:   workingXml,
        finalName:  workingName,
        readyToDeploy: true,
      };
    }

    // ── STEP 4: Real deploy ─────────────────────────────────────────────────
    push('deploy', 'running', 'Running real deploy...');
    const realResult = await deployArtifact({
      artifactXml:  workingXml,
      artifactType,
      apiName:      workingName,
      sfClient,
      checkOnly:    false,
      activate,
    });

    push('deploy', realResult.success ? 'passed' : 'failed',
      realResult.success ? 'Deployed successfully' : realResult.error?.message);

    return {
      success:    realResult.success,
      stage:      'deploy',
      preflight,
      dryRun:     dryRunResult,
      realDeploy: realResult,
      classified: [],
      questions:  realResult.success ? [] : [realResult.error?.message],
      log,
      finalXml:   workingXml,
      finalName:  workingName,
    };
  }

  // Dry run failed — apply deterministic fixes
  push('dryrun', 'failed', `${classified.length} error(s) classified`);

  const deterministicErrors = classified.filter(c => c.deterministic && c.fix);
  const manualErrors        = classified.filter(c => !c.deterministic || !c.fix);

  let fixedByLoop = 0;
  for (const err of deterministicErrors) {
    try {
      const fixed = err.fix(workingXml);
      if (fixed && fixed !== workingXml) {
        workingXml = fixed;
        fixedByLoop++;
        push('repair', 'fixed', `Auto-fixed ${err.category}`);
      }
    } catch {
      // Fix threw — treat as unfixable
      manualErrors.push(err);
    }
  }

  // ── STEP 5: Second dry run if we applied fixes ────────────────────────────
  if (fixedByLoop > 0) {
    push('dryrun2', 'running', 'Re-running dry run after auto-repairs...');
    try {
      const dryRun2 = await deployArtifact({
        artifactXml:  workingXml,
        artifactType,
        apiName:      workingName,
        sfClient,
        checkOnly:    true,
        activate:     false,
      });

      if (dryRun2.success) {
        push('dryrun2', 'passed', 'Second dry run passed after auto-repair');
        return {
          success:       true,
          stage:         'dryrun2',
          preflight,
          dryRun:        dryRunResult,
          dryRun2:       dryRun2,
          classified,
          questions:     [],
          log,
          finalXml:      workingXml,
          finalName:     workingName,
          readyToDeploy: !realDeploy,
          repairedIssues: fixedByLoop,
        };
      }

      const remaining = classifyDeployResult(dryRun2, artifactType, workingName);
      push('dryrun2', 'failed', `${remaining.length} errors remain after auto-repair`);
      return {
        success:    false,
        stage:      'dryrun2',
        preflight,
        dryRun:     dryRunResult,
        dryRun2,
        classified: remaining,
        questions:  remaining.map(c => c.question),
        log,
        finalXml:   workingXml,
        finalName:  workingName,
        needsClaudeRepair: true,
        repairHints: remaining.map(c => c.promptRule),
      };
    } catch (err) {
      push('dryrun2', 'error', err.message);
    }
  }

  // Can't fix automatically — return questions for user/Claude
  return {
    success:    false,
    stage:      'dryrun',
    preflight,
    dryRun:     dryRunResult,
    classified,
    questions:  manualErrors.map(c => c.question),
    log,
    finalXml:   workingXml,
    finalName:  workingName,
    needsClaudeRepair: manualErrors.some(c => !c.deterministic),
    repairHints: manualErrors.map(c => c.promptRule),
  };
}

module.exports = { runDeployLoop };
