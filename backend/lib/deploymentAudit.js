'use strict';

const supabase = require('./supabase');
const { DEPLOYMENT_STATES, stageToState } = require('./deploymentState');

function isMissingTableError(err) {
  const message = err?.message || String(err || '');
  return /does not exist|schema cache|could not find the table|relation .*deployment_/i.test(message);
}

async function createDeploymentRun({
  userId,
  orgId,
  metadataType,
  componentName,
  requestText = '',
  requestedAction = 'deploy',
  status = 'running',
  currentStage = DEPLOYMENT_STATES.PREFLIGHT_RUNNING,
  finalDeployConfirmed = false,
}) {
  try {
    const { data, error } = await supabase
      .from('deployment_runs')
      .insert({
        user_id: userId,
        connected_org_id: orgId,
        metadata_type: metadataType,
        component_name: componentName,
        requested_action: requestedAction,
        status,
        current_stage: currentStage,
        request_text: requestText,
        final_deploy_confirmed: finalDeployConfirmed,
      })
      .select('id')
      .single();

    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[deploymentAudit] create run failed:', err.message);
    return null;
  }
}

async function recordGeneratedArtifact({
  deploymentRunId,
  metadataType,
  componentName,
  artifactXml,
  generatedSummary,
  modelUsed,
  changeReason = 'Initial generated artifact',
}) {
  if (!deploymentRunId || !artifactXml) return null;
  try {
    const { data, error } = await supabase
      .from('generated_artifacts')
      .insert({
        deployment_run_id: deploymentRunId,
        metadata_type: metadataType,
        component_name: componentName,
        artifact_xml: artifactXml,
        generated_summary: generatedSummary || null,
        model_used: modelUsed || null,
      })
      .select('id')
      .single();

    if (error) throw error;
    const artifactId = data?.id;
    if (artifactId) {
      await supabase.from('artifact_versions').insert({
        artifact_id: artifactId,
        version_number: 1,
        change_reason: changeReason,
        artifact_xml: artifactXml,
      });
    }
    return artifactId || null;
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[deploymentAudit] artifact record failed:', err.message);
    return null;
  }
}

async function recordArtifactVersion({
  artifactId,
  versionNumber,
  changeReason,
  diffFromPrevious,
  artifactXml,
}) {
  if (!artifactId || !artifactXml) return;
  try {
    await supabase.from('artifact_versions').insert({
      artifact_id: artifactId,
      version_number: versionNumber,
      change_reason: changeReason || 'Auto-repair',
      diff_from_previous: diffFromPrevious || null,
      artifact_xml: artifactXml,
    });
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[deploymentAudit] version record failed:', err.message);
  }
}

async function recordDeploymentErrors({ deploymentRunId, stage, classified = [] }) {
  if (!deploymentRunId || !classified.length) return;
  try {
    const rows = classified.map((item) => ({
      deployment_run_id: deploymentRunId,
      stage: stage || 'unknown',
      raw_error: item.rawError || item.question || 'Unknown Salesforce deploy error',
      error_category: item.category || 'UNKNOWN',
      root_cause: item.rootCause || item.root_cause || null,
      repair_strategy: item.repairStrategy || item.promptRule || null,
      safe_to_auto_repair: Boolean(item.safeToAutoRepair || item.safe_to_auto_repair || item.deterministic),
      confidence: typeof item.confidence === 'number' ? item.confidence : (item.deterministic ? 0.9 : 0.65),
      resolved: Boolean(item.resolved),
    }));
    await supabase.from('deployment_errors').insert(rows);
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[deploymentAudit] error record failed:', err.message);
  }
}

async function finalizeDeploymentRun({ deploymentRunId, result, dryRunPassed, summary = {} }) {
  if (!deploymentRunId) return;
  try {
    const finalState = stageToState(result?.stage, result);
    const terminal = [DEPLOYMENT_STATES.DEPLOYED, DEPLOYMENT_STATES.DEPLOY_FAILED, DEPLOYMENT_STATES.READY_TO_DEPLOY].includes(finalState);
    await supabase
      .from('deployment_runs')
      .update({
        status: result?.success ? (result?.realDeploy ? 'completed' : 'ready') : 'blocked',
        current_stage: finalState,
        dry_run_passed: Boolean(dryRunPassed),
        result_summary: summary,
        completed_at: terminal ? new Date().toISOString() : null,
      })
      .eq('id', deploymentRunId);
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('[deploymentAudit] finalize run failed:', err.message);
  }
}

module.exports = {
  createDeploymentRun,
  recordGeneratedArtifact,
  recordArtifactVersion,
  recordDeploymentErrors,
  finalizeDeploymentRun,
};
