export class RetryBudget {
  private totalRequests = 0;
  private totalRetries = 0;

  constructor(
    private budgetPercent = 15,
    private decayFactor = 0.9,
  ){}
  public setBudgetPercent(percent: number){
    this.budgetPercent = percent;
  }
  public recordRequest(){
    this.totalRequests = this.totalRequests * this.decayFactor + 1;
    this.totalRetries = this.totalRetries * this.decayFactor;
  }
  public recordRetry(): boolean {
    if(this.totalRequests >= 10){
      const ratio = (this.totalRetries + 1) / (this.totalRequests + 1);
      if(ratio > this.budgetPercent / 100){
        return false;
      }
    }
    this.totalRequests = this.totalRequests * this.decayFactor;
    this.totalRetries = this.totalRetries * this.decayFactor + 1;
    return true;
  }
  public getStats(){
    return {
      totalRequests: this.totalRequests,
      totalRetries: this.totalRetries,
      ratio: this.totalRetries / (this.totalRequests + 1),
    };
  }
}
export const globalRetryBudget = new RetryBudget();
