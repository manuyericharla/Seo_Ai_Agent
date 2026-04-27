import { Router } from 'express';
import {
  postScan,
  getReports,
  postSendReport,
  getDomains,
  postDomain,
  getDashboardStats,
  getActivity,
  getSettings,
  putSettings,
  postGooglePageSpeedTest,
  postSerpApiTest,
  postSerpLiveRank,
  postIssueGithub,
  postIssuePullRequest,
  postScanClaudePr,
  postScanClaudePrEmail,
  getSeoTrend,
  getScanReportPdf,
  getPageReportsJson,
  getKeywordOpportunities,
  getLatestKeywordOpportunities,
  getBacklinkAnalytics,
  getLatestBacklinkAnalytics,
  getImageAltRouteMap,
  getLatestImageAltRouteMap,
  postStopScan,
} from '../controllers/scan.controller';

export const scanRouter = Router();

scanRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'SEO Agent API',
    health: '/health',
    examples: [
      'GET /api/reports',
      'GET /api/domains',
      'GET /api/dashboard-stats',
    ],
    ui: 'Run the Angular app (npm start) and open http://localhost:4200 — it proxies /api to this server.',
  });
});

scanRouter.post('/scan', (req, res) => {
  void postScan(req, res);
});
scanRouter.post('/scan/:scanId/stop', postStopScan);
scanRouter.get('/reports/:scanId/pdf', (req, res) => {
  void getScanReportPdf(req, res);
});
scanRouter.get('/reports/:scanId/json', (req, res) => {
  void getPageReportsJson(req, res);
});
scanRouter.get('/reports/:scanId/keyword-opportunities', getKeywordOpportunities);
scanRouter.get('/reports/latest/keyword-opportunities', getLatestKeywordOpportunities);
scanRouter.get('/reports/:scanId/backlink-analytics', getBacklinkAnalytics);
scanRouter.get('/reports/latest/backlink-analytics', getLatestBacklinkAnalytics);
scanRouter.get('/reports/:scanId/image-alt-route-map', getImageAltRouteMap);
scanRouter.get('/reports/latest/image-alt-route-map', getLatestImageAltRouteMap);
scanRouter.get('/reports', getReports);
scanRouter.post('/send-report', (req, res) => {
  void postSendReport(req, res);
});
scanRouter.get('/domains', getDomains);
scanRouter.post('/domains', postDomain);
scanRouter.get('/dashboard-stats', getDashboardStats);
scanRouter.get('/activity', getActivity);
scanRouter.get('/settings', getSettings);
scanRouter.put('/settings', putSettings);
scanRouter.post('/settings/google-pagespeed/test', (req, res) => {
  void postGooglePageSpeedTest(req, res);
});
scanRouter.post('/settings/serpapi/test', (req, res) => {
  void postSerpApiTest(req, res);
});
scanRouter.post('/serp/live-rank', (req, res) => {
  void postSerpLiveRank(req, res);
});
scanRouter.post('/issues/:id/github', (req, res) => {
  void postIssueGithub(req, res);
});
scanRouter.post('/issues/:id/pull-request', (req, res) => {
  void postIssuePullRequest(req, res);
});
scanRouter.post('/scans/:scanId/claude-pr', (req, res) => {
  void postScanClaudePr(req, res);
});
scanRouter.post('/scans/:scanId/claude-pr/email', (req, res) => {
  void postScanClaudePrEmail(req, res);
});
scanRouter.get('/seo-trend', getSeoTrend);
