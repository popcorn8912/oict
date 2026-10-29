/**
 * Client-side rule AGT-4: an AI assistant's answer is bound to the scene
 * object and selection version it was asked about. A late answer about a
 * previous product or variant is never shown as if it described the current one.
 */

export interface SelectionView {
  sceneObjectId: string;
  variantId: string;
  selectionVersion: number;
}

export interface BoundAgentResponse<T = string> {
  requestId: string;
  boundTo: SelectionView;
  body: T;
}

export function bindAgentResponse<T>(requestId: string, boundTo: SelectionView, body: T): BoundAgentResponse<T> {
  return { requestId, boundTo: { ...boundTo }, body };
}

export function isAgentResponseCurrent(response: BoundAgentResponse<unknown>, current: SelectionView): boolean {
  return (
    response.boundTo.sceneObjectId === current.sceneObjectId &&
    response.boundTo.variantId === current.variantId &&
    response.boundTo.selectionVersion === current.selectionVersion
  );
}
