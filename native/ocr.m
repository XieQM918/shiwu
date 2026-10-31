#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdlib.h>

static double darkRatio(const unsigned char *pixels,size_t w,size_t h,int fixed,int start,int end,BOOL vertical){
  int limit=(int)(vertical?h:w),cross=(int)(vertical?w:h);
  if(fixed<0||fixed>=cross)return 0;start=MAX(0,start);end=MIN(limit,end);
  if(end-start<25)return 0;int dark=0;
  for(int n=start;n<end;n++)if(pixels[vertical?(size_t)n*w+fixed:(size_t)fixed*w+n]<145)dark++;
  return (double)dark/(end-start);
}
static NSDictionary *rulerEvidence(const unsigned char *pixels,size_t w,size_t h,double x,double y,double bw,double bh,NSString *text){
  if(!pixels)return nil;
  NSRegularExpression *pattern=[NSRegularExpression regularExpressionWithPattern:@"^[\\-−–—]?\\s*[0-9]+(?:\\.[0-9]+)?\\s*(?:mm|cm|毫米|厘米)$" options:NSRegularExpressionCaseInsensitive error:nil];
  if(![pattern firstMatchInString:text options:0 range:NSMakeRange(0,text.length)])return nil;
  double cx=(x+bw/2)*w,cy=(y+bh/2)*h,vertical=0,horizontal=0;
  int radiusX=MAX(4,(int)(bw*w*.18)),radiusY=MAX(4,(int)(bh*h*.6));
  for(int column=(int)cx-radiusX;column<=(int)cx+radiusX;column++){
    double above=darkRatio(pixels,w,h,column,(int)(cy-.16*h),(int)(y*h-.012*h),YES);
    double below=darkRatio(pixels,w,h,column,(int)((y+bh)*h+.012*h),(int)(cy+.16*h),YES);
    vertical=MAX(vertical,MIN(above,below));
  }
  for(int row=(int)cy-radiusY;row<=(int)cy+radiusY;row++){
    double left=darkRatio(pixels,w,h,row,(int)(cx-.19*w),(int)(x*w-.012*w),NO);
    double right=darkRatio(pixels,w,h,row,(int)((x+bw)*w+.012*w),(int)(cx+.19*w),NO);
    horizontal=MAX(horizontal,MIN(left,right));
  }
  if(vertical>.2&&vertical>horizontal+.12)return @{@"rulerAxis":@"vertical",@"rulerScore":@(vertical)};
  if(horizontal>.2&&horizontal>vertical+.12)return @{@"rulerAxis":@"horizontal",@"rulerScore":@(horizontal)};
  return nil;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr,"缺少图片路径\n"); return 1; }
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url,NULL);
    if (!source) { fprintf(stderr,"图片格式无法读取\n"); return 1; }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source,0,NULL);
    CFRelease(source);
    if (!image) { fprintf(stderr,"图片解码失败\n"); return 1; }
    size_t width=CGImageGetWidth(image),height=CGImageGetHeight(image);
    if(argc>2 && strcmp(argv[2],"--info")==0) {
      printf("{\"width\":%zu,\"height\":%zu}\n",width,height);
      CGImageRelease(image);return 0;
    }
    unsigned char *pixels=NULL;
    if(width*height<=40000000 && height<=width*4){
      pixels=calloc(width*height,1);
      if(pixels){CGColorSpaceRef gray=CGColorSpaceCreateDeviceGray();CGContextRef bitmap=CGBitmapContextCreate(pixels,width,height,8,width,gray,kCGImageAlphaNone);CGColorSpaceRelease(gray);if(bitmap){CGContextSetGrayFillColor(bitmap,1,1);CGContextFillRect(bitmap,CGRectMake(0,0,width,height));CGContextDrawImage(bitmap,CGRectMake(0,0,width,height),image);CGContextRelease(bitmap);}else{free(pixels);pixels=NULL;}}
    }
    NSMutableArray *lines=[NSMutableArray array];
    size_t offset=0;int segment=0;
    while(offset<height) {
      @autoreleasepool {
        size_t h=MIN(2200,height-offset);
        CGImageRef crop=CGImageCreateWithImageInRect(image,CGRectMake(0,offset,width,h));
        VNRecognizeTextRequest *request=[[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel=VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection=NO;
        NSError *error=nil;
        NSArray *supported=[request supportedRecognitionLanguagesAndReturnError:&error];
        NSMutableArray *languages=[NSMutableArray array];
        for(NSString *lang in @[@"zh-Hans",@"en-US"]) if([supported containsObject:lang]) [languages addObject:lang];
        request.recognitionLanguages=languages;
        VNImageRequestHandler *handler=[[VNImageRequestHandler alloc] initWithCGImage:crop options:@{}];
        BOOL ok=[handler performRequests:@[request] error:&error];
        CGImageRelease(crop);
        if(!ok) { fprintf(stderr,"%s\n",error.localizedDescription.UTF8String);CGImageRelease(image);return 1; }
        for(VNRecognizedTextObservation *observation in request.results) {
          VNRecognizedText *candidate=[[observation topCandidates:1] firstObject];
          if(!candidate) continue;
          CGRect b=observation.boundingBox;
          double y=((double)offset+(1-CGRectGetMaxY(b))*h)/height;
          BOOL duplicate=NO;
          for(NSDictionary *line in lines) if([line[@"text"] isEqualToString:candidate.string] && fabs([line[@"y"] doubleValue]-y)<.012 && fabs([line[@"x"] doubleValue]-b.origin.x)<.02) {duplicate=YES;break;}
          if(!duplicate){
            double bh=b.size.height*h/height;
            NSMutableDictionary *line=[@{@"text":candidate.string,@"confidence":@(candidate.confidence),@"x":@(b.origin.x),@"y":@(y),@"width":@(b.size.width),@"height":@(bh),@"segment":@(segment)} mutableCopy];
            NSDictionary *ruler=rulerEvidence(pixels,width,height,b.origin.x,y,b.size.width,bh,candidate.string);
            if(ruler)[line addEntriesFromDictionary:ruler];
            [lines addObject:line];
          }
        }
        if(offset+h>=height) break;
        offset+=2040;segment++;
      }
    }
    CGImageRelease(image);
    free(pixels);
    [lines sortUsingComparator:^NSComparisonResult(NSDictionary *a,NSDictionary *b){
      double d=[a[@"y"] doubleValue]-[b[@"y"] doubleValue];
      if(fabs(d)<.004) d=[a[@"x"] doubleValue]-[b[@"x"] doubleValue];
      return d<0?NSOrderedAscending:d>0?NSOrderedDescending:NSOrderedSame;
    }];
    NSError *error=nil;
    NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"width":@(width),@"height":@(height),@"lines":lines} options:0 error:&error];
    if(!json) {fprintf(stderr,"%s\n",error.localizedDescription.UTF8String);return 1;}
    fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);
  }
  return 0;
}
