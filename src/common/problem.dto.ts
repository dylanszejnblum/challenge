/** RFC 9457 problem details, the shape of every error response. */
export class ProblemDto {
  /** @example about:blank */
  type!: string;
  /** @example "Bad Request" */
  title!: string;
  /** @example 400 */
  status!: number;
  /** @example "Validation failed" */
  detail!: string;
  /** Field-level messages, only on validation errors. @example ["price must be a positive decimal with up to 2 decimals and below 100000000"] */
  errors?: string[];
  /** @example /orders */
  instance!: string;
}
