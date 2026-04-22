import { Routes } from '@angular/router';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { DomainManagementComponent } from './components/domain-management/domain-management.component';
import { ScanResultsComponent } from './components/scan-results/scan-results.component';
import { IssueCreateComponent } from './components/issue-create/issue-create.component';
import { SettingsComponent } from './components/settings/settings.component';
import { AutomaticSchedulerComponent } from './components/automatic-scheduler/automatic-scheduler.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'domains', component: DomainManagementComponent },
  { path: 'scans', component: ScanResultsComponent },
  { path: 'issue-create', component: IssueCreateComponent },
  { path: 'automatic-scheduler', component: AutomaticSchedulerComponent },
  { path: 'issues', redirectTo: 'issue-create' },
  { path: 'pr-management', redirectTo: 'scans' },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: '' },
];
