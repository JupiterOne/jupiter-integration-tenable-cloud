import { IntegrationStepExecutionContext } from '@jupiterone/integration-sdk-core';

import { TenableIntegrationConfig } from './config';
import {
  createContainerReportUnwantedProgramRelationships,
  createMalwareEntities,
  createReportMalwareRelationships,
  createUnwantedProgramEntities,
} from './converters';
import {
  createScanFindingRelationship,
  createScanVulnerabilityRelationship,
  createVulnerabilityFindingEntity,
  createVulnerabilityFindingRelationship,
} from './converters/vulnerabilities';
import { AssetExportCache, VulnerabilityExportCache } from './tenable';
import { createAssetExportCache } from './tenable/createAssetExportCache';
import { createVulnerabilityExportCache } from './tenable/createVulnerabilityExportCache';
import TenableClient from './tenable/TenableClient';
import {
  ContainerMalware,
  ContainerReport,
  ContainerUnwantedProgram,
  Dictionary,
  RecentScanSummary,
  ScanHost,
  ScanStatus,
  ScanVulnerabilitySummary,
  VulnerabilityExport,
} from './tenable/types';

export async function synchronizeHosts(
  context: IntegrationStepExecutionContext<TenableIntegrationConfig>,
  scanSummaries: RecentScanSummary[],
): Promise<void> {
  const provider = new TenableClient({
    logger: context.logger,
    accessToken: context.instance.config.accessKey,
    secretToken: context.instance.config.secretKey,
  });

  const assetCache = await createAssetExportCache(context.logger, provider);
  const vulnerabilityCache = await createVulnerabilityExportCache(
    context.logger,
    provider,
  );

  /* istanbul ignore next */
  for (const scanSummary of scanSummaries) {
    if (scanSummary.status === ScanStatus.Completed) {
      const scanDetail = await provider.fetchScanDetail(scanSummary);
      if (scanDetail) {
        if (scanDetail.vulnerabilities) {
          await synchronizeScanVulnerabilities(
            context,
            scanSummary,
            scanDetail.vulnerabilities,
          );
        }
        // If the scan detail is archived any calls
        // to sync the host details will give a 404 until
        // we add the export functionality requested by
        // Tenable. POST /scans/scan_id/export
        if (scanDetail.hosts && !scanDetail.info.is_archived) {
          context.logger.info(
            {
              scanDetailHosts: scanDetail.hosts.length,
            },
            'Processing scan detail hosts...',
          );
          for (const host of scanDetail.hosts) {
            await synchronizeHostVulnerabilities(
              context,
              assetCache,
              vulnerabilityCache,
              scanSummary,
              host,
            );
          }
        }
      }
    }
  }
}

export async function synchronizeScanVulnerabilities(
  context: IntegrationStepExecutionContext<TenableIntegrationConfig>,
  scan: RecentScanSummary,
  vulnerabilties: ScanVulnerabilitySummary[],
): Promise<void> {
  const { logger } = context;

  const vulnLogger = logger.child({
    scan: {
      id: scan.id,
      uuid: scan.uuid,
    },
  });

  vulnLogger.info(
    { scanVulnerabilities: vulnerabilties.length },
    'Processing vulnerabilities discovered by recent scan...',
  );

  for (const vuln of vulnerabilties) {
    await context.jobState.addRelationship(
      createScanVulnerabilityRelationship(scan, vuln),
    );
  }

  vulnLogger.info(
    'Processing vulnerabilities discovered by recent scan completed.',
  );
}

/**
 * Creates findings for each host vulnerability identified by the scan. Note
 * that multiple different scans may identify the same vulnerability; the graph
 * will have a finding of the vulnerability for each scan because they are
 * different findings.
 */
export async function synchronizeHostVulnerabilities(
  context: IntegrationStepExecutionContext<TenableIntegrationConfig>,
  assetCache: AssetExportCache,
  vulnerabilityCache: VulnerabilityExportCache,
  scan: RecentScanSummary,
  scanHost: ScanHost,
): Promise<void> {
  const { logger } = context;
  const provider = new TenableClient({
    logger,
    accessToken: context.instance.config.accessKey,
    secretToken: context.instance.config.secretKey,
  });

  const vulnLogger = logger.child({
    scan: {
      id: scan.id,
      uuid: scan.uuid,
    },
    scanHost: {
      hostname: scanHost.hostname,
      id: scanHost.host_id,
      uuid: scanHost.uuid,
    },
  });

  const scanHostVulnerabilities = await provider.fetchScanHostVulnerabilities(
    scan.id,
    scanHost.host_id,
  );

  const hostAsset = assetCache.findAssetExportByUuid(scanHost.uuid);

  /* istanbul ignore next */
  if (!hostAsset) {
    vulnLogger.info(
      'No asset found for scan host, some details cannot be provided',
    );
  }

  /* istanbul ignore next */
  const assetUuid = hostAsset ? hostAsset.id : scanHost.uuid;

  logger.info(
    {
      assetUuid,
      scanHostVulnerabilities: scanHostVulnerabilities.length,
    },
    'Processing host vulnerabilities discovered by recent scan...',
  );

  for (const vulnerability of scanHostVulnerabilities) {
    let vulnerabilityExport: VulnerabilityExport | undefined;
    /* istanbul ignore next */
    if (assetUuid) {
      vulnerabilityExport =
        vulnerabilityCache.findVulnerabilityExportByAssetPluginUuid(
          assetUuid,
          vulnerability.plugin_id,
        );
    }

    await context.jobState.addEntity(
      createVulnerabilityFindingEntity({
        scan,
        asset: hostAsset,
        assetUuid,
        vulnerability,
        vulnerabilityExport,
      }),
    );

    await context.jobState.addRelationship(
      createVulnerabilityFindingRelationship({
        scan,
        assetUuid,
        vulnerability,
      }),
    );

    await context.jobState.addRelationship(
      createScanFindingRelationship({ scan, assetUuid, vulnerability }),
    );
  }

  logger.info(
    'Processing host vulnerabilities discovered by recent scan completed.',
  );
}

export async function synchronizeContainerMalware(
  {
    jobState,
    logger,
  }: IntegrationStepExecutionContext<TenableIntegrationConfig>,
  containerReports: ContainerReport[],
) {
  const malwares: Dictionary<ContainerMalware[]> = {};

  for (const report of containerReports) {
    /* istanbul ignore next */
    if (!malwares[report.sha256]) {
      malwares[report.sha256] = [];
    }
    /* istanbul ignore next */
    malwares[report.sha256] = malwares[report.sha256].concat(report.malware);
  }

  logger.info('Synchronizing container malware');
  await jobState.addEntities(createMalwareEntities(malwares));
  logger.info('Finished synchronizing container malware');

  logger.info('Synchronizing report -> malware relationships');
  await jobState.addEntities(
    createReportMalwareRelationships(containerReports, malwares),
  );
  logger.info('Finished synchronizing report -> malware relationships');
}

export async function synchronizeContainerUnwantedPrograms(
  {
    jobState,
    logger,
  }: IntegrationStepExecutionContext<TenableIntegrationConfig>,
  containerReports: ContainerReport[],
) {
  const unwantedPrograms: Dictionary<ContainerUnwantedProgram[]> = {};

  for (const report of containerReports) {
    /* istanbul ignore next */
    if (!unwantedPrograms[report.sha256]) {
      unwantedPrograms[report.sha256] = [];
    }
    /* istanbul ignore next */
    unwantedPrograms[report.sha256] = unwantedPrograms[report.sha256].concat(
      report.potentially_unwanted_programs,
    );
  }

  logger.info('Synchronizing container unwanted programs');
  await jobState.addEntities(createUnwantedProgramEntities(unwantedPrograms));
  logger.info('Finished synchronizing container unwanted programs');

  logger.info('Synchronizing report -> unwanted program relationships');
  await jobState.addRelationships(
    createContainerReportUnwantedProgramRelationships(
      containerReports,
      unwantedPrograms,
    ),
  );
  logger.info(
    'Finished synchronizing report -> unwanted program relationships',
  );
}
