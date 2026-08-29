export class TagInvalidator {
  private tagMap = new Map<string, Set<string>>();

  tag(cacheKey: string, tags: string[]){
    for (const tag of tags){
      if (!this.tagMap.has(tag)) this.tagMap.set(tag, new Set());
      this.tagMap.get(tag)!.add(cacheKey);
    }
  }
  getKeysForTag(tag: string): string[] {
    return [...(this.tagMap.get(tag) ?? [])];
  }
  removeTag(tag: string){
    this.tagMap.delete(tag);
  }
} 
