// services/assistantScreens.js
//
// Screens the in-app assistant may offer as an "Open" button.
// The ids are shared with the Flutter app (lib/assistant/assistant_screens.dart).
// A user is only offered screens of his own role; the backend filters the
// model's answer against this list, so a Supervisor can never receive an
// Admin screen even if the model returned one.

const SCREENS = [
  // Everyone
  { id: 'change_password', title: 'Change Password', roles: ['Admin', 'Supervisor', 'StaffSupervisor'] },

  // Admin: sidebar pages
  { id: 'live_operations', title: 'Live Operations', roles: ['Admin'] },
  { id: 'workers', title: 'Workers', roles: ['Admin'] },
  { id: 'attendance_review', title: 'Attendance Review', roles: ['Admin'] },
  { id: 'daily_site_report', title: 'Daily Site Report', roles: ['Admin'] },
  { id: 'project_daily_report', title: 'Project Daily Report', roles: ['Admin'] },
  { id: 'dpr_admin', title: 'Daily Progress (DPR)', roles: ['Admin'] },
  { id: 'payroll', title: 'Payroll', roles: ['Admin'] },
  { id: 'projects', title: 'Projects', roles: ['Admin'] },
  { id: 'worker_distribution', title: 'Worker Distribution', roles: ['Admin'] },
  { id: 'hr_management', title: 'HR Management', roles: ['Admin'] },
  { id: 'transfer_requests', title: 'Transfer Requests', roles: ['Admin'] },
  { id: 'staff_attendance_payroll', title: 'Staff Attendance & Payroll', roles: ['Admin'] },
  { id: 'supervisors_management', title: 'Supervisors Management', roles: ['Admin'] },
  { id: 'biometric_processing', title: 'Biometric Processing', roles: ['Admin'] },
  { id: 'biometric_import', title: 'Biometric Import', roles: ['Admin'] },
  { id: 'device_id_mapping', title: 'Device ID Mapping', roles: ['Admin'] },
  { id: 'roles_permissions', title: 'Roles & Permissions', roles: ['Admin'] },
  { id: 'user_accounts', title: 'User Accounts', roles: ['Admin'] },
  // Admin: pages opened from inside other pages
  { id: 'payroll_adjustments', title: 'Payroll Adjustments', roles: ['Admin'] },
  { id: 'recycle_bin', title: 'Recycle Bin', roles: ['Admin'] },
  { id: 'staff_management', title: 'Staff Management', roles: ['Admin'] },

  // Site supervisor
  { id: 'supervisor_home', title: 'My Sites', roles: ['Supervisor'] },
  { id: 'rejected_records', title: 'Rejected Records', roles: ['Supervisor'] },
  { id: 'transfer_request', title: 'Worker Transfer Request', roles: ['Supervisor'] },

  // Staff supervisor
  { id: 'staff_supervisor_home', title: 'Home', roles: ['StaffSupervisor'] },
  { id: 'staff_attendance', title: 'Staff Attendance', roles: ['StaffSupervisor'] },
];

const ROLES = ['Admin', 'Supervisor', 'StaffSupervisor'];

function screensForRole(role) {
  return SCREENS.filter((s) => s.roles.includes(role));
}

function screenById(id) {
  return SCREENS.find((s) => s.id === id) || null;
}

module.exports = { SCREENS, ROLES, screensForRole, screenById };
