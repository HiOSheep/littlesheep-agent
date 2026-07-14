// Approval UI and request types; authority remains in the main process.
import {
type ApprovalRequest
} from '../api'
import {
type ApprovalDecision
} from '../approval-grants'


export interface PendingApprovalPrompt {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
}
