"""Synthetic regression cases for the local split path; no private artwork."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from PIL import Image, ImageChops, ImageDraw
from split_common import validate_landmarks, row_fill, flat_palette, darkest_path, unmatte_white, square_pad, square_unpad
from split_layers import foreground_mask, move_shadows, conserve_visible_pixels, ORDER
from split_peel import peeled_layers
from split_ownership import nearest_labels, snap_boundaries, assemble_owned, constrain_completed_labels, assemble_completed, protect_face_owners, match_hidden_rear_hair, COLORS
from split_refinement import resolve_missing,refine_layers,prioritize_removed_hair,source_skin_mask,extend_crown_to_outline,transfer_fringe_shadows,fringe_face_scope,clean_fringe_fragments
from split_image import bundle, validation_scope, build_request, checked_result, removed_hair, generated_face_surface
from expression_requests_common import file_hash
from split_ownership_layers import expand_layers,FEATURES,BODY
from split_requests import prepare_request,register_result
from split_features import select_face_parts,face_part_references,clean_skin_field,nearest_face_labels,generated_face,generated_face_references
from expression_color import mouth_skin_ring,match_mouth_skin


def landmarks():
    return {'schemaVersion':1,'canvas':[100,120],
            'eyes':[{'center':[35,44],'width':20,'height':12},{'center':[65,44],'width':20,'height':12}],
            'brows':[{'center':[35,33],'width':20,'height':8},{'center':[65,33],'width':20,'height':8}],
            'ears':[{'center':[21,55],'width':10,'height':16},{'center':[79,55],'width':10,'height':16}],
            'mouth':{'center':[50,67],'width':16,'height':6},'nose':{'center':[50,56],'width':6,'height':6},
            'hairPart':[50,9],'chin':[50,80],'bangTips':[[25,40],[55,37],[75,40]],'collar':[[25,95],[50,105],[75,95]],'accessories':[]}


class Rules(unittest.TestCase):
    def test_adopted_eye_registration_requires_identical_ink_and_preserves_every_line(self):
        from overlay_expression import register_adopted_closed_eyes
        art=Image.new('RGBA',(200,100));outline=Image.new('RGBA',art.size)
        for x in (45,145):
            ImageDraw.Draw(outline).line((x-10,40,x+10,40),fill='black')
            ImageDraw.Draw(art).line((x-20,45,x,45),fill=(55,25,10,255))
        result,report=register_adopted_closed_eyes(art,art.copy(),outline)
        self.assertEqual(result.getchannel('A').histogram(),art.getchannel('A').histogram())
        self.assertEqual([v['dxNative'] for v in report['sides'].values()],[10,10])
        new_art=art.copy();new_art.putpixel((45,45),(0,0,0,255))
        with self.assertRaisesRegex(ValueError,'previously adopted'):
            register_adopted_closed_eyes(new_art,art,outline)

    def test_closed_eye_registration_moves_both_sides_without_changing_ink_or_height(self):
        from overlay_expression import register_closed_eyes
        art=Image.new('RGBA',(200,100));outline=Image.new('RGBA',art.size);allowed=Image.new('L',art.size,255)
        for x in (45,145):
            ImageDraw.Draw(outline).rectangle((x-15,30,x+15,50),fill='black')
            ImageDraw.Draw(art).line((x-6,52,x+24,52),fill=(50,20,10,255),width=2)
        result,report=register_closed_eyes(art,outline,allowed)
        self.assertEqual([v['dxNative'] for v in report['sides'].values()],[-9,-9])
        self.assertEqual(result.getchannel('A').histogram(),art.getchannel('A').histogram())
        self.assertEqual(result.getchannel('A').getbbox()[1::2],art.getchannel('A').getbbox()[1::2])
        self.assertEqual(result.getpixel((45,52)),(50,20,10,255))

    def test_closed_eye_registration_keeps_small_offsets_and_rejects_large_drift(self):
        from overlay_expression import register_closed_eyes
        art=Image.new('RGBA',(200,100));outline=Image.new('RGBA',art.size);allowed=Image.new('L',art.size,255)
        for x in (45,145):
            ImageDraw.Draw(outline).line((x-10,40,x+10,40),fill='black')
            ImageDraw.Draw(art).line((x-3,45,x+17,45),fill='black')
        self.assertEqual(register_closed_eyes(art,outline,allowed)[0].tobytes(),art.tobytes())
        shifted=Image.new('RGBA',art.size);shifted.paste(art,(7,0))
        with self.assertRaisesRegex(ValueError,'exceeds 12'):
            register_closed_eyes(shifted,outline,allowed)

    def test_closed_eye_registration_rejects_movement_outside_the_original_mask(self):
        from overlay_expression import register_closed_eyes
        art=Image.new('RGBA',(200,100));outline=Image.new('RGBA',art.size);allowed=Image.new('L',art.size)
        for x in (45,145):
            ImageDraw.Draw(outline).line((x-10,40,x+10,40),fill='black')
            ImageDraw.Draw(art).line((x-1,45,x+19,45),fill='black')
            ImageDraw.Draw(allowed).rectangle((x-1,44,x+19,46),fill=255)
        with self.assertRaisesRegex(ValueError,'original editable region'):
            register_closed_eyes(art,outline,allowed)

    def test_closed_eye_registration_removes_only_recorded_faint_outside_noise(self):
        from overlay_expression import register_closed_eyes
        art=Image.new('RGBA',(200,100));outline=Image.new('RGBA',art.size);allowed=Image.new('L',art.size)
        for x in (45,145):
            ImageDraw.Draw(outline).line((x-10,40,x+10,40),fill='black')
            ImageDraw.Draw(art).line((x-20,45,x,45),fill='black')
            ImageDraw.Draw(allowed).rectangle((x-25,40,x+30,50),fill=255)
            art.putpixel((x+30,45),(250,210,180,3))
        result,report=register_closed_eyes(art,outline,allowed)
        self.assertEqual([v['removedOutsideNoisePixels'] for v in report['sides'].values()],[1,1])
        self.assertEqual(sum(a>16 for a in result.getchannel('A').tobytes()),sum(a>16 for a in art.getchannel('A').tobytes()))

    def test_accessory_ink_keeps_thin_source_lines_without_skin_or_background(self):
        from split_accessories import retain_accessory_ink
        from split_ownership import snap_boundaries
        source=Image.new('RGB',(32,24),(245,220,200));fg=Image.new('L',source.size,255)
        labels=Image.new('L',source.size,3)
        ImageDraw.Draw(labels).rectangle((5,8,25,9),fill=9)
        ImageDraw.Draw(source).line((5,11,25,11),fill=(35,25,20),width=1)
        source.putpixel((5,12),(255,255,255));fg.putpixel((5,12),0)
        source.putpixel((6,12),(255,255,255))
        palettes={'skin':[(245,220,200)],'hair':[(35,25,20)]}
        result,report,_=retain_accessory_ink(source,labels,fg,palettes)
        self.assertEqual(result.getpixel((15,11)),9)
        self.assertEqual(result.getpixel((15,9)),3)
        self.assertNotEqual(result.getpixel((5,12)),9)
        self.assertEqual(result.getpixel((6,12)),9)
        self.assertEqual(report['radiusPx'],3)
        snapped,_,_=snap_boundaries(source,result,fg)
        for i,n in enumerate(result.tobytes()):
            if n==9:self.assertEqual(snapped.tobytes()[i],9)
        legacy=Image.new('L',source.size,3)
        unchanged,_,_=retain_accessory_ink(source,legacy,fg,palettes)
        self.assertEqual(legacy.tobytes(),unchanged.tobytes())

    def test_accessory_standard_expansion_preserves_composite(self):
        size=(20,20);source=Image.new('RGBA',size,(245,245,245,255));p1=Image.new('RGBA',size,(100,60,30,255));full=Image.new('L',size,255)
        labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((3,2,16,4),fill=8);labels.putpixel((7,10),9)
        hair=Image.new('L',size);ImageDraw.Draw(hair).rectangle((0,0,19,5),fill=255)
        candidate,_,_,_=assemble_completed(source,p1,p1,p1,full,labels,hair,full,full,full)
        reference={name:Image.new('RGBA',size) for name in BODY+FEATURES}
        layers,_,_,check=expand_layers(candidate,labels,reference)
        self.assertTrue(check['pass']);self.assertIn('headwear',layers);self.assertIn('eyewear',layers)
        self.assertEqual(layers['eyewear'].getpixel((7,10)),source.getpixel((7,10)))
        self.assertEqual(layers['eyewear'].getpixel((8,10))[3],0)

    def test_white_headwear_interior_is_not_background(self):
        source=Image.new('RGB',(100,120),'white');ImageDraw.Draw(source).rectangle((30,10,70,25),outline='black',width=2)
        lm=landmarks();lm['accessories']=[{'layer':'headwear','box':{'center':[50,18],'width':44,'height':20}}]
        fg,_=foreground_mask(source,lm)
        self.assertEqual(fg.getpixel((50,18)),255)
        self.assertEqual(fg.getpixel((10,18)),0)

    def test_undeclared_accessory_labels_cannot_claim_face_artwork(self):
        from split_accessories import constrain_accessory_labels
        labels=Image.new('L',(100,120),3);labels.putpixel((50,44),9);labels.putpixel((50,18),8)
        art=Image.new('RGB',labels.size,COLORS[3]);lm=landmarks();lm['accessories']=[{'layer':'headwear','box':{'center':[50,18],'width':30,'height':12}}]
        fixed,report=constrain_accessory_labels(labels,art,lm)
        self.assertEqual(fixed.getpixel((50,44)),3);self.assertEqual(fixed.getpixel((50,18)),8)
        self.assertEqual(report['detachedAccessoryPixelsReassigned'],1)

    def test_accessory_component_rule_ignores_boxes_and_keeps_touching_parts(self):
        from split_accessories import constrain_accessory_labels
        labels=Image.new('L',(100,120),1);d=ImageDraw.Draw(labels);d.rectangle((20,10,50,20),fill=8);labels.putpixel((51,21),8);labels.putpixel((50,50),8)
        lm=landmarks();lm['accessories']=[{'layer':'headwear','box':{'center':[50,50],'width':2,'height':2}}]
        fixed,report=constrain_accessory_labels(labels,Image.new('RGB',labels.size),lm)
        self.assertEqual(fixed.getpixel((51,21)),8);self.assertEqual(fixed.getpixel((50,50)),1)
        self.assertEqual(report['detachedAccessoryPixelsReassigned'],1)

    def test_isolated_head_clothing_returns_to_hair_but_collar_remains(self):
        from split_accessories import constrain_garment_labels
        labels=Image.new('L',(100,120),2);d=ImageDraw.Draw(labels);d.rectangle((10,20,15,30),fill=6);d.rectangle((10,90,80,119),fill=6)
        fixed,report=constrain_garment_labels(labels,landmarks())
        self.assertEqual(fixed.getpixel((12,22)),2);self.assertEqual(fixed.getpixel((12,92)),6)
        self.assertEqual(report['detachedHeadClothingPixelsReassigned'],66)

    def test_accessory_palette_retains_legacy_quantization(self):
        im=Image.new('RGB',(2,1));im.putdata([COLORS[8],COLORS[9]])
        self.assertEqual(list(nearest_labels(im,10).getdata()),[8,9])
        self.assertTrue(all(n<8 for n in nearest_labels(im,8).tobytes()))

    def test_accessories_keep_visible_source_and_real_hidden_hair(self):
        from split_accessories import accessory_layers
        size=(12,12);source=Image.new('RGBA',size,(250,250,250,255))
        p1=Image.new('RGBA',size,(60,20,10,255));fg=Image.new('L',size,255)
        labels=Image.new('L',size,3);labels.putpixel((4,4),8);labels.putpixel((6,7),9)
        layers={'front hair':Image.new('RGBA',size)}
        accessory_layers(source,p1,fg,labels,fg,fg,layers)
        self.assertEqual(layers['headwear'].getpixel((4,4)),source.getpixel((4,4)))
        self.assertEqual(layers['front hair'].getpixel((4,4)),p1.getpixel((4,4)))
        self.assertEqual(layers['eyewear'].getpixel((6,7)),source.getpixel((6,7)))
        self.assertEqual(layers['eyewear'].getpixel((5,7))[3],0)
        self.assertEqual(layers['front hair'].getpixel((6,7))[3],0)

    def test_accessory_owners_are_not_reassigned_as_removed_hair(self):
        size=(100,120);full=Image.new('L',size,255);labels=Image.new('L',size,8);labels.putpixel((60,44),9)
        result,_,_=prioritize_removed_hair(labels,full,full,full,Image.new('L',size),Image.new('L',size))
        self.assertEqual(result.tobytes(),labels.tobytes())


    def test_ear_shape_uses_complete_map_components_without_rectangular_cuts(self):
        size=(100,120);p1=Image.new('RGBA',size,(250,220,190,255));full=Image.new('L',size,255)
        labels=Image.new('L',size,3);draw=ImageDraw.Draw(labels)
        draw.polygon([(18,45),(28,55),(26,70),(17,62)],fill=4)
        labels.putpixel((50,60),4)
        candidate={'base':p1.copy(),'front hair':Image.new('RGBA',size),'back hair':Image.new('RGBA',size)}
        _,masks,_=generated_face(p1,p1,labels,full,full,candidate,Image.new('L',size,7),landmarks())
        self.assertEqual(masks['generated-ears'].getpixel((25,68)),255)
        self.assertEqual(masks['generated-ears'].getpixel((50,60)),0)
        self.assertEqual(masks['generated-ears'].getpixel((26,48)),0)

    def test_hidden_neck_overlap_preserves_every_neutral_pixel(self):
        size=(100,120);base=Image.new('RGBA',size,(250,220,190,255))
        ImageDraw.Draw(base).rectangle((0,80,99,119),fill=(200,160,130,255))
        labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((0,80,99,119),fill=5)
        scope=labels.point(lambda n:255 if n==3 else 0)
        candidate={'base':base,'front hair':Image.new('RGBA',size),'back hair':Image.new('RGBA',size)}
        reference={n:Image.new('RGBA',size) for n in BODY+FEATURES};reference['face']=base.copy()
        layers,composite,_,check=expand_layers(candidate,labels,reference,scope,Image.new('L',size))
        self.assertTrue(check['pass']);self.assertEqual(composite.tobytes(),base.tobytes())
        self.assertEqual(layers['neck'].getpixel((50,75)),(200,160,130,255))
        self.assertEqual(layers['neck'].getpixel((50,60))[3],0)
        self.assertGreater(check['hiddenNeckOverlap']['pixels'],0)

    def test_source_matte_does_not_cut_p3_beneath_an_opaque_generated_face(self):
        size=(100,120);fg=Image.new('L',size);ImageDraw.Draw(fg).rectangle((20,20,80,100),fill=255)
        source=Image.new('RGBA',size,'white');ImageDraw.Draw(source).rectangle((20,20,80,100),fill=(250,220,190,255))
        ImageDraw.Draw(source).line((20,20,20,100),fill=(254,250,245,255))
        p1=Image.new('RGBA',size,(250,220,190,255));labels=fg.point(lambda n:3 if n else 0)
        base=source.copy();base.putalpha(fg);rear=Image.new('RGBA',size,(70,35,15,255));rear.putalpha(fg)
        candidate={'back hair':rear,'base':base,'front hair':Image.new('RGBA',size)}
        palettes={'skin':[(250,220,190)],'hair':[(70,35,15)]}
        layers,_,check,_,report,_=refine_layers(source,p1,fg,labels,candidate,palettes,landmarks(),skin=fg,
            face_parts=Image.new('L',size,7),face_source='generated')
        self.assertTrue(check['pass'])
        self.assertEqual(layers['back hair'].getpixel((20,50)),(70,35,15,255))
        self.assertGreater(report['generatedFace']['rearRestoredUnderOpaqueFacePixels'],0)

    def test_generated_face_clears_mouth_edge_without_changing_neutral_paint(self):
        size=(100,120);skin=(250,220,190,255);p1=Image.new('RGBA',size,skin)
        ImageDraw.Draw(p1).line((42,65,58,65),fill=(80,40,20,255))
        # The map missed a two-pixel fringe of the original mouth stroke.
        parts=Image.new('L',size,7);ImageDraw.Draw(parts).line((44,67,56,67),fill=5)
        labels=Image.new('L',size,3);full=Image.new('L',size,255)
        candidate={'base':p1.copy(),'front hair':Image.new('RGBA',size),'back hair':Image.new('RGBA',size)}
        scope,masks,_=generated_face(p1,p1,labels,full,full,candidate,parts,landmarks())
        reference={n:Image.new('RGBA',size) for n in BODY+FEATURES};reference['face']=p1.copy()
        reference=generated_face_references(candidate['base'],reference,masks['face-parts-selected'],scope,masks['face-parts-clean-skin'])
        layers,_,_,check=expand_layers(candidate,labels,reference,scope,masks['generated-ears'])
        self.assertTrue(check['pass'])
        self.assertEqual(layers['face'].getpixel((42,65)),skin)
        self.assertEqual(layers['mouth'].getpixel((42,65)),p1.getpixel((42,65)))

    def test_mouth_skin_matching_preserves_ink_alpha_and_protected_pixels(self):
        size=(100,120);underlay=Image.new('RGBA',size,(250,220,190,255))
        generated=Image.new('RGBA',size,(240,200,180,255))
        support=Image.new('L',size);ImageDraw.Draw(support).line((44,67,56,67),fill=255)
        nose=Image.new('RGBA',size);ImageDraw.Draw(nose).rectangle((48,52,52,56),fill=(70,35,15,255))
        ring=mouth_skin_ring({'face':underlay,'nose':nose},support)
        self.assertEqual(ring.getpixel((50,54)),0)
        self.assertEqual(ring.getpixel((50,77)),255)
        editable=Image.new('L',size);ImageDraw.Draw(editable).rectangle((40,61,60,73),fill=255)
        ImageDraw.Draw(generated).line((44,67,56,67),fill=(70,35,15,255))
        corrected,report=match_mouth_skin(generated,underlay,ring,editable)
        self.assertEqual(corrected.getpixel((40,61)),underlay.getpixel((40,61)))
        self.assertEqual(corrected.getpixel((0,0)),generated.getpixel((0,0)))
        self.assertEqual(corrected.getchannel('A').tobytes(),generated.getchannel('A').tobytes())
        self.assertLess(max(corrected.getpixel((50,67))[:3]),80)
        self.assertTrue(report['protectedChecksUseUncorrectedResult'])
        with self.assertRaisesRegex(ValueError,'No opaque skin samples'):
            match_mouth_skin(generated,underlay,Image.new('L',size),editable)

    def test_complete_generated_face_keeps_one_art_source_and_preserves_body(self):
        size=(100,120);source=Image.new('RGBA',size,(200,170,140,255));p1=Image.new('RGBA',size,(250,220,190,255))
        labels=Image.new('L',size,6);ImageDraw.Draw(labels).rectangle((20,20,80,80),fill=3);ImageDraw.Draw(labels).rectangle((20,80,80,99),fill=5)
        parts=Image.new('L',size,7);ImageDraw.Draw(parts).rectangle((26,31,44,35),fill=1);ImageDraw.Draw(p1).rectangle((26,31,44,35),fill=(70,35,15,255))
        candidate={'base':source.copy(),'front hair':Image.new('RGBA',size),'back hair':Image.new('RGBA',size)};full=Image.new('L',size,255)
        scope,masks,report=generated_face(source,p1,labels,full,full,candidate,parts,landmarks())
        for xy in [(43,33),(50,60)]:self.assertEqual(candidate['base'].getpixel(xy),p1.getpixel(xy))
        for xy in [(50,90),(50,110)]:self.assertEqual(candidate['base'].getpixel(xy),source.getpixel(xy))
        reference={n:Image.new('RGBA',size) for n in BODY+FEATURES};reference['face']=source.copy()
        ImageDraw.Draw(reference['eyebrow']).rectangle((26,28,44,30),fill=(10,10,10,255))
        reference=generated_face_references(candidate['base'],reference,masks['face-parts-selected'],scope,masks['face-parts-clean-skin'])
        layers,_,_,check=expand_layers(candidate,labels,reference,scope,masks['generated-ears'])
        self.assertTrue(check['pass']);self.assertFalse(report['originalFaceArtworkUsed'])
        self.assertEqual(layers['face'].getpixel((43,33)),(250,220,190,255))
        self.assertEqual(layers['eyebrow'].getpixel((43,33)),p1.getpixel((43,33)))
        self.assertEqual(layers['eyebrow'].getpixel((30,28))[3],0)

    def test_generated_semantic_brow_selects_one_owner_and_one_rig_layer(self):
        size=(100,120);skin=(250,220,190,255);ink=(70,35,15,255);source_ink=(90,45,25,255)
        p1=Image.new('RGBA',size,skin);ImageDraw.Draw(p1).rectangle((26,31,44,35),fill=ink)
        source=Image.new('RGBA',size,skin);ImageDraw.Draw(source).rectangle((26,31,44,35),fill=source_ink)
        parts=Image.new('L',size,7);ImageDraw.Draw(parts).rectangle((26,31,44,35),fill=1)
        full=Image.new('L',size,255);scope=Image.new('L',size);scope.putpixel((26,33),255)
        for right,owner in [(29,'source'),(40,'p1')]:
            labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((20,20,right,36),fill=1)
            front=source.copy();front.putalpha(labels.point(lambda n:255 if n==1 else 0))
            candidate={'base':source.copy(),'front hair':front,'back hair':Image.new('RGBA',size)}
            _,masks,report=select_face_parts(source,p1,labels,full,full,scope,candidate,parts,landmarks())
            self.assertEqual([r['owner'] for r in report['parts']],[owner])
            self.assertEqual(candidate['base'].getpixel((43,33)),ink if owner=='p1' else source_ink)
            reference={n:Image.new('RGBA',size) for n in BODY+FEATURES};reference['face']=p1.copy()
            reference=face_part_references(candidate['base'],reference,masks['face-parts-selected'],masks['face-parts-patches'],masks['face-parts-clean-skin'])
            layers,_,_,check=expand_layers(candidate,labels,reference)
            self.assertTrue(check['pass']);self.assertEqual(layers['face'].getpixel((43,33)),skin)
            self.assertEqual(layers['eyebrow'].getpixel((43,33)),ink if owner=='p1' else source_ink)
            self.assertEqual(candidate['base'].getpixel((80,80)),source.getpixel((80,80)))

    def test_skin_backing_excludes_features_without_quantization_speckles(self):
        image=Image.new('RGBA',(80,80),(250,220,190,255));known=Image.new('L',image.size,255);target=Image.new('L',image.size)
        ImageDraw.Draw(image).rectangle((10,10,69,69),fill=(20,10,5,255));ImageDraw.Draw(known).rectangle((8,8,71,71),fill=0)
        ImageDraw.Draw(target).rectangle((10,10,69,69),fill=255)
        clean=clean_skin_field(image,known,target,4)
        self.assertEqual(set(clean.getdata()),{(250,220,190,255)})
        with self.assertRaisesRegex(ValueError,'No feature-free'):clean_skin_field(image,Image.new('L',image.size),target,4)

    def test_face_map_iris_highlights_keep_iris_ownership(self):
        image=Image.new('RGB',(20,20),(128,128,128));draw=ImageDraw.Draw(image)
        draw.rectangle((2,2,17,17),fill=(0,255,0));draw.rectangle((5,5,7,7),fill='white');image.putpixel((0,0),(255,0,0))
        labels=nearest_face_labels(image)
        self.assertEqual(labels.getpixel((6,6)),4);self.assertEqual(labels.getpixel((0,0)),1)

    def test_face_part_request_records_native_p1_and_landmark_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'ownership-refined-preview').mkdir();(root/'split').mkdir()
            source=root/'source.png';Image.new('RGBA',(100,120),(250,220,190,255)).save(source)
            Image.open(source).save(root/'ownership-refined-preview/p1.png')
            (root/'split/landmarks.json').write_text(json.dumps(landmarks()))
            job={'input':{'file':str(source),'sha256':file_hash(source)}}
            (root/'ownership-refined-preview/review.json').write_text(json.dumps({'sourceSha256':file_hash(source),'p1Sha256':'raw-p1-hash'}))
            result=prepare_request(root,'face-parts',job);record=json.loads(Path(result['request']).read_text())
            self.assertEqual(record['p1NativeSha256'],file_hash(root/'ownership-refined-preview/p1.png'))
            self.assertEqual(record['landmarksSha256'],file_hash(root/'split/landmarks.json'))
            self.assertEqual(record['palette']['eyebrow'],[255,0,0]);self.assertEqual(record['size'][0],record['size'][1])

    def test_explicit_generated_face_scope_carries_cleaned_holes_into_face_layer(self):
        size=(8,8);base=Image.new('RGBA',size,(250,220,190,255));labels=Image.new('L',size,3);labels.putpixel((3,3),2)
        ref={n:Image.new('RGBA',size) for n in BODY+FEATURES};ref['face']=base.copy()
        candidate={'base':base,'back hair':Image.new('RGBA',size),'front hair':Image.new('RGBA',size)}
        with self.assertRaisesRegex(ValueError,'no supported non-hair owner'):expand_layers(candidate,labels,ref)
        scope=Image.new('L',size);scope.putpixel((3,3),255)
        layers,composite,_,check=expand_layers(candidate,labels,ref,generated_face=scope)
        self.assertTrue(check['pass']);self.assertEqual(layers['face'].getpixel((3,3)),base.getpixel((3,3)))
        self.assertEqual(composite.tobytes(),base.tobytes())

    def test_isolated_fringe_cleanup_is_bounded_and_preserves_connected_p1_ink(self):
        size=(30,30);p1=Image.new('RGBA',size,(250,220,190,255));source=p1.copy();scope=Image.new('L',size)
        ImageDraw.Draw(scope).rectangle((2,2,27,27),fill=255)
        for xy in [(6,6),(10,10),(15,15)]:scope.putpixel(xy,0);source.putpixel(xy,(70,35,15,255))
        p1.putpixel((10,11),(70,35,15,255));fg=Image.new('L',size,255);fg.putpixel((15,15),0)
        ImageDraw.Draw(scope).rectangle((18,18,24,24),fill=0)
        layers={'base':source.copy(),'front hair':Image.new('RGBA',size)}
        updated,clean,report=clean_fringe_fragments(source,p1,fg,scope,layers,{'skin':[(250,220,190)],'hair':[(70,35,15)]})
        self.assertEqual(clean.getpixel((6,6)),255)
        for xy in [(10,10),(15,15),(20,20),(0,0)]:self.assertEqual(clean.getpixel(xy),0)
        self.assertEqual(layers['base'].getpixel((6,6)),p1.getpixel((6,6)))
        self.assertEqual(report['replacedPixels'],1)

    def test_p1_face_keeps_source_hair_at_protection_edges_without_moving_actual_p1_brows(self):
        size=(100,120);source=Image.new('RGBA',size,(250,220,190,255));p1=source.copy()
        labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((20,10,75,31),fill=1)
        for xy in [(35,32),(35,33)]:source.putpixel(xy,(70,35,15,255))
        p1.putpixel((35,33),(70,35,15,255))
        hair=Image.new('L',size);hair.putpixel((35,32),255);hair.putpixel((35,33),255)
        layers={'base':source.copy(),'front hair':Image.new('RGBA',size)};full=Image.new('L',size,255)
        masks,_=transfer_fringe_shadows(source,p1,full,labels,layers,{'skin':[(250,220,190)],'hair':[(70,35,15)]},landmarks(),full,source_hair=hair)
        self.assertEqual(masks['fringe-shadow-transferred'].getpixel((35,32)),255)
        self.assertEqual(masks['fringe-shadow-transferred'].getpixel((35,33)),0)
        self.assertEqual(Image.alpha_composite(layers['base'],layers['front hair']).tobytes(),source.tobytes())

    def test_generated_fringe_scope_fills_bang_gaps_but_not_face_between_long_side_locks(self):
        size=(100,120);labels=Image.new('L',size,3);d=ImageDraw.Draw(labels)
        d.rectangle((20,5,80,20),fill=1);d.rectangle((20,20,23,100),fill=1);d.rectangle((77,20,80,100),fill=1)
        full=Image.new('L',size,255);skin=full.copy();fg=full.copy();base=Image.new('RGBA',size,(250,220,190,255))
        fg.putpixel((50,25),0);skin.putpixel((51,25),0);base.putpixel((52,25),(0,0,0,0));labels.putpixel((53,25),4)
        scope,radius=fringe_face_scope(labels,fg,skin,base,landmarks())
        self.assertEqual(scope.getpixel((45,25)),255)
        self.assertEqual(scope.getpixel((50,70)),0)
        for x in [50,51,52,53]:self.assertEqual(scope.getpixel((x,25)),0)
        self.assertEqual(radius,2)

    def test_generated_fringe_mode_reports_static_change_without_allowing_outside_drift(self):
        size=(100,120);source=Image.new('RGBA',size,(250,220,190,255));p1=source.copy()
        labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((20,10,75,30),fill=1)
        source.putpixel((50,31),(200,160,130,255));p1.putpixel((50,31),(210,170,140,255))
        # A lighter registered P1 brow gap is explicitly permitted only inside
        # the face scope; keep it away from the narrow shadow transfer itself.
        source.putpixel((45,25),(250,220,190,255));p1.putpixel((45,25),(70,35,15,255))
        labels.putpixel((45,25),3)
        front=source.copy();front.putalpha(labels.point(lambda n:255 if n==1 else 0))
        layers={'back hair':Image.new('RGBA',size),'base':source.copy(),'front hair':front}
        full=Image.new('L',size,255)
        _,composite,check,masks,_,_=refine_layers(source,p1,full,labels,layers,{'skin':[(250,220,190)],'hair':[(70,35,15)]},landmarks(),skin=full,p1_fringe_face=True)
        self.assertTrue(check['pass']);self.assertFalse(check['exactSourcePass'])
        self.assertEqual(check['generatedFringeFace']['outsideChangedPixels'],0)
        self.assertGreater(check['generatedFringeFace']['changedPixels'],0)
        self.assertEqual(composite.getpixel((50,80)),source.getpixel((50,80)))

    def test_fringe_shadows_follow_hair_but_preserve_generated_brow_and_eye_ink(self):
        size=(100,120);source=Image.new('RGBA',size,(250,220,190,255));p1=source.copy()
        labels=Image.new('L',size,3);d=ImageDraw.Draw(labels)
        d.rectangle((20,10,75,31),fill=1);d.rectangle((20,40,24,48),fill=1)
        front=labels.point(lambda n:255 if n==1 else 0)
        source.paste((70,35,15,255),(0,0,*size),front)
        for xy in [(42,32),(50,34),(35,33),(26,44)]:source.putpixel(xy,(190,120,70,255))
        for xy in [(35,33),(26,44)]:
            p1.putpixel(xy,(70,35,15,255));source.putpixel(xy,(70,35,15,255))
        layers={'base':source.copy(),'front hair':source.copy()};layers['front hair'].putalpha(front)
        full=Image.new('L',size,255)
        masks,report=transfer_fringe_shadows(source,p1,full,labels,layers,{'skin':[(250,220,190)],'hair':[(70,35,15)]},landmarks(),full)
        moved=masks['fringe-shadow-transferred']
        self.assertEqual(moved.getpixel((42,32)),255)
        for xy in [(50,34),(35,33),(26,44)]:self.assertEqual(moved.getpixel(xy),0)
        self.assertEqual(layers['base'].getpixel((42,32)),p1.getpixel((42,32)))
        self.assertLess(layers['front hair'].getpixel((42,32))[3],255)
        self.assertEqual(Image.alpha_composite(layers['base'],layers['front hair']).tobytes(),source.tobytes())
        self.assertEqual(report['transferredPixels'],1)

    def test_face_ownership_guard_keeps_ink_and_landmark_skin_but_not_overlapping_hair(self):
        original=Image.new('L',(100,120),1);labels=original.copy();fg=Image.new('L',original.size,255)
        original.putpixel((35,44),3);original.putpixel((36,44),7);original.putpixel((80,90),7)
        original.putpixel((37,44),1);original.putpixel((38,44),2);original.putpixel((80,85),3)
        final,mask,report=protect_face_owners(labels,original,fg,landmarks())
        for xy,v in [((35,44),3),((36,44),7),((80,90),7),((37,44),1),((38,44),1),((80,85),1)]:self.assertEqual(final.getpixel(xy),v)
        self.assertEqual(report['restoredFromHairPixels'],3);self.assertEqual(report['remainingHairPixels'],0)

    def test_generation_requests_and_registration_keep_source_and_raw_output_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source.png';Image.new('RGBA',(12,16),(100,50,20,255)).save(source)
            job={'input':{'file':str(source),'sha256':file_hash(source)}}
            request=prepare_request(root,'ownership',job);meta=Path(request['request'])
            record=json.loads(meta.read_text());self.assertEqual(record['padding'],[2,0,2,0])
            result=root/'generated.png';Image.new('RGB',(16,16),(255,0,0)).save(result)
            saved=register_result(root,'ownership',result,job)
            self.assertEqual(saved['callsUsed'],1);self.assertEqual(file_hash(Path(saved['result'])),file_hash(result))
            self.assertEqual(json.loads(meta.read_text())['resultSha256'],file_hash(result))
            self.assertTrue(register_result(root,'ownership',result,job)['alreadyRegistered'])
            Image.new('RGBA',(16,16),'black').save(meta.parent/'input.png')
            with self.assertRaisesRegex(ValueError,'input changed'):register_result(root,'ownership',result,job)

    def test_thin_hair_without_eroded_interior_still_recovers_white_matte(self):
        source=Image.new('RGB',(15,15),'white');fg=Image.new('L',source.size)
        for y in range(3,12):source.putpixel((7,y),(246,246,244));fg.putpixel((7,y),255)
        result=unmatte_white(source,fg,edge_width=6,fallback_colours=[(90,45,20)])
        self.assertLess(result.getpixel((7,7))[3],32);self.assertLess(max(result.getpixel((7,7))[:3]),150)
        composite=Image.alpha_composite(Image.new('RGBA',source.size,'white'),result).convert('RGB')
        self.assertEqual(composite.tobytes(),source.tobytes())

    def test_renewed_p3_request_preserves_prior_files_and_rolls_back_bad_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source.png';p1=root/'legacy-p1.png'
            Image.new('RGBA',(16,16),(100,50,20,255)).save(source)
            Image.new('RGBA',(16,16),(200,150,100,255)).save(p1)
            split=root/'split';split.mkdir()
            (split/'generation-check.json').write_text(json.dumps({'pass':True,'resultSha256':file_hash(p1)}))
            job={'input':{'file':str(source),'sha256':file_hash(source)}}
            first=prepare_request(root,'p3',job,p1_file=p1);folder=Path(first['request']).parent
            raw=root/'raw.png';Image.new('RGB',(16,16),(70,35,15)).save(raw)
            register_result(root,'p3',raw,job)
            before={f.name:f.read_bytes() for f in folder.iterdir()}
            with self.assertRaisesRegex(ValueError,'already exists'):prepare_request(root,'p3',job,p1_file=p1)
            bad=root/'bad.png';Image.new('RGB',(16,16),'white').save(bad)
            with self.assertRaisesRegex(ValueError,'P1 must pass'):
                prepare_request(root,'p3',job,p1_file=bad,renew_request=True)
            self.assertEqual(before,{f.name:f.read_bytes() for f in folder.iterdir()})
            new=prepare_request(root,'p3',job,p1_file=p1,renew_request=True)
            record=json.loads(Path(new['request']).read_text());old=Path(record['previousRequest']['path'])
            self.assertEqual(file_hash(old),record['previousRequest']['sha256'])
            self.assertEqual(before,{f.name:f.read_bytes() for f in old.parent.iterdir()})
            self.assertNotIn('resultSha256',record);self.assertFalse((folder/'result.png').exists())
            self.assertEqual(len(json.loads((split/'generations.json').read_text())['entries']),1)
            self.assertIn('dark underside',Path(new['prompt']).read_text())

    def test_hidden_rear_hair_matches_source_shadow_without_changing_visible_hair_or_alpha(self):
        size=(60,40);source=Image.new('RGBA',size,(240,210,180,255));d=ImageDraw.Draw(source)
        d.rectangle((0,0,19,39),fill=(40,20,10,255));d.rectangle((40,0,59,39),fill=(120,80,50,255))
        labels=Image.new('L',size,3);d=ImageDraw.Draw(labels);d.rectangle((0,0,19,39),fill=2);d.rectangle((40,0,59,39),fill=2)
        p3=Image.new('RGBA',size,(100,50,25,255));p3.putpixel((29,20),(80,40,20,128))
        p3.putpixel((30,20),(50,25,10,255));p3.putpixel((31,20),(150,75,40,255))
        fg=Image.new('L',size,255);result,hidden,_,report=match_hidden_rear_hair(source,p3,fg,labels,fg)
        self.assertEqual(report['sourceShadowRgb'],[40,20,10]);self.assertEqual(result.getpixel((28,20)),(40,20,10,255))
        self.assertEqual(result.getpixel((10,20)),p3.getpixel((10,20)))
        self.assertEqual(result.getchannel('A').tobytes(),p3.getchannel('A').tobytes())
        self.assertLess(result.getpixel((30,20))[0],result.getpixel((31,20))[0])
        self.assertEqual(hidden.getpixel((10,20)),0);self.assertEqual(hidden.getpixel((30,20)),255)

    def test_crown_extension_keeps_upper_hair_connected_and_preserves_ears_skin(self):
        labels=Image.new('L',(100,120),2);ImageDraw.Draw(labels).rectangle((10,0,40,90),fill=1)
        fg=Image.new('L',labels.size,255);ears=Image.new('L',labels.size);skin=ears.copy()
        labels.putpixel((60,20),3);ears.putpixel((70,20),255);skin.putpixel((71,20),255);fg.putpixel((99,20),0)
        source=Image.new('RGB',labels.size,(110,60,20))
        final,changes,report=extend_crown_to_outline(labels,fg,ears,skin,landmarks(),source)
        self.assertEqual(final.getpixel((80,20)),1)
        for xy in [(60,20),(70,20),(71,20),(99,20)]:self.assertEqual(final.getpixel(xy),labels.getpixel(xy))
        self.assertEqual(report['aboveEarY'],55);self.assertGreater(report['changedPixels'],0)

    def test_extended_side_bundle_follows_dark_gap_to_tip_without_horizontal_cut(self):
        size=(100,120);labels=Image.new('L',size);fg=Image.new('L',size);source=Image.new('RGB',size,'white')
        draw=ImageDraw.Draw(labels);draw.rectangle((10,10,80,54),fill=2);draw.rectangle((20,10,60,54),fill=1);draw.rectangle((60,55,80,100),fill=2)
        fg=labels.point(lambda n:255 if n else 0);source.paste((130,75,30),(0,0,100,120),fg)
        for y in range(55,101):source.putpixel((60+(y-55)//15,y),(35,15,5))
        empty=Image.new('L',size);final,changes,report=extend_crown_to_outline(labels,fg,empty,empty,landmarks(),source)
        self.assertEqual(final.getpixel((75,90)),1);self.assertEqual(final.getpixel((75,101)),0)
        self.assertEqual(final.getpixel((60,90)),2)
        path=report['bundleGapPaths']['right'];self.assertEqual(path[-1][1],100)
        self.assertTrue(all(abs(b[0]-a[0])<=3 for a,b in zip(path,path[1:])))
        self.assertGreater(report['continuedSideBundlePixels'],0)

    def test_standard_layers_keep_candidate_paint_and_hidden_face_eye_backing(self):
        size=(8,8);base=Image.new('RGBA',size,(250,220,190,255));base.putpixel((3,3),(60,25,10,255));base.putpixel((4,3),(245,245,245,255))
        labels=Image.new('L',size,3);labels.putpixel((0,0),6);labels.putpixel((1,0),5);labels.putpixel((2,0),4)
        ref={n:Image.new('RGBA',size) for n in BODY+FEATURES};ref['face']=Image.new('RGBA',size,(248,218,188,255));ref['eyewhite'].putpixel((3,3),(245,245,245,255));ref['eyewhite'].putpixel((4,3),(245,245,245,255));ref['irides'].putpixel((3,3),(60,25,10,255))
        rear=Image.new('RGBA',size,(80,40,20,255));front=Image.new('RGBA',size);front.putpixel((5,1),(90,45,25,255));candidate={'back hair':rear,'base':base,'front hair':front}
        layers,comp,owners,check=expand_layers(candidate,labels,ref)
        self.assertTrue(check['pass']);self.assertEqual(check['changedPixels'],0)
        self.assertEqual(layers['face'].getpixel((3,3)),(248,218,188,255));self.assertEqual(layers['eyewhite'].getpixel((3,3)),(245,245,245,255));self.assertEqual(layers['irides'].getpixel((3,3)),base.getpixel((3,3)))
        for name,xy in [('topwear',(0,0)),('neck',(1,0)),('ears',(2,0))]:
            self.assertEqual(layers[name].getpixel(xy),base.getpixel(xy));self.assertEqual(layers['face'].getpixel(xy)[3],0)
        self.assertEqual(layers['front hair'].tobytes(),front.tobytes());self.assertEqual(layers['back hair'].tobytes(),rear.tobytes())
        ref['face'].putpixel((3,3),(0,0,0,0))
        with self.assertRaisesRegex(ValueError,'underlay'):expand_layers(candidate,labels,ref)

    def test_original_hair_with_revealed_p1_skin_overrides_all_map_owners(self):
        labels=Image.new('L',(8,2));labels.putdata(list(range(8))*2)
        hair=Image.new('L',labels.size,255);skin=hair.copy();fg=hair.copy()
        hair.putpixel((0,1),0);skin.putpixel((2,1),0);fg.putpixel((3,1),0)
        empty=Image.new('L',labels.size)
        final,support,report=prioritize_removed_hair(labels,hair,skin,fg,empty,empty)
        self.assertEqual(list(final.crop((0,0,8,1)).getdata()),[1]*8)
        for xy in [(0,1),(2,1),(3,1)]:
            self.assertEqual(final.getpixel(xy),labels.getpixel(xy));self.assertEqual(support.getpixel(xy),0)
        self.assertEqual(report['supportPixels'],13);self.assertEqual(report['changedPixels'],11)
        self.assertEqual(report['remainingNonFrontPixels'],0)

    def test_hair_priority_preserves_mapped_ears_and_original_skin(self):
        source=Image.new('RGB',(4,1));source.putdata([(70,35,15),(250,220,190),(70,35,15),(70,35,15)])
        skin=source_skin_mask(source,{'skin':[(250,220,190)],'hair':[(70,35,15)],'topwear':[(220,40,20)]})
        labels=Image.new('L',source.size);labels.putdata([4,3,3,2]);full=Image.new('L',source.size,255)
        # The last pixel was an ear in the generated map even though a later
        # geometry stage assigned it to hair. It must still be excluded.
        ears=Image.new('L',source.size);ears.putdata([255,0,0,255])
        final,support,report=prioritize_removed_hair(labels,full,full,full,ears,skin)
        self.assertEqual(list(final.getdata()),[4,3,1,2]);self.assertEqual(list(support.getdata()),[0,0,255,0])
        self.assertEqual(report['excludedMapEarPixels'],2);self.assertEqual(report['excludedSourceSkinPixels'],1);self.assertEqual(report['changedPixels'],1)

    def test_bare_arm_palette_cannot_steal_head_skin(self):
        source=Image.new('RGB',(2,1));source.putdata([(250,220,190),(70,35,15)])
        palettes={'skin':[(248,218,188)],'hair':[(70,35,15)],'topwear':[(250,220,190)]}
        self.assertEqual(list(source_skin_mask(source,palettes).getdata()),[255,0])

    def test_missing_ownership_joins_existing_part_without_claiming_background(self):
        labels=Image.new('L',(12,12));fg=Image.new('L',labels.size)
        ImageDraw.Draw(labels).rectangle((2,2,5,5),fill=1);ImageDraw.Draw(labels).rectangle((2,8,9,10),fill=6)
        ImageDraw.Draw(fg).rectangle((2,2,5,5),fill=255);ImageDraw.Draw(fg).rectangle((2,8,9,10),fill=255)
        labels.putpixel((5,5),0);labels.putpixel((9,10),0)
        final,report=resolve_missing(labels,fg)
        self.assertEqual(final.getpixel((5,5)),1);self.assertEqual(final.getpixel((9,10)),6);self.assertEqual(final.getpixel((0,0)),0)
        self.assertEqual(report['resolvedPixels'],2)

    def test_unfaded_upper_hair_and_white_edge_keep_exact_source_white_composite(self):
        size=(100,120);lm=landmarks();fg=Image.new('L',size);ImageDraw.Draw(fg).rectangle((10,8,90,110),fill=255)
        source=Image.new('RGBA',size,'white');d=ImageDraw.Draw(source);d.rectangle((10,8,90,110),fill=(170,145,130,255));d.rectangle((12,10,88,108),fill=(70,35,15,255));d.rectangle((30,55,70,80),fill=(250,220,190,255))
        p1=source.copy();ImageDraw.Draw(p1).rectangle((30,20,70,80),fill=(250,220,190,255));p2=p1.copy();p3=Image.new('RGBA',size,(90,45,20,255))
        labels=Image.new('L',size);ImageDraw.Draw(labels).rectangle((10,8,90,110),fill=2);ImageDraw.Draw(labels).rectangle((30,10,70,54),fill=1);ImageDraw.Draw(labels).rectangle((30,55,70,80),fill=3)
        layers,_,_,_=assemble_completed(source,p1,p2,p3,fg,labels,Image.new('L',size),fg,fg,fg)
        result,comp,check,masks,report,_=refine_layers(source,p1,fg,labels,layers,{'skin':[(250,220,190)],'neck':[(250,220,190)],'hair':[(70,35,15)]},lm)
        self.assertEqual(result['base'].getpixel((35,18))[3],0)
        self.assertEqual(result['front hair'].getpixel((35,10))[3],255)
        self.assertEqual(result['front hair'].getpixel((35,20))[3],255)
        self.assertEqual(result['front hair'].getpixel((35,54))[3],255)
        self.assertGreater(report['whiteMattePixelsRecovered'],0)
        self.assertEqual(report['hiddenBaseOutsideP1SkinFinal'],0)
        self.assertEqual(report['rootFadePixels'],0);self.assertIsNone(masks['root-fade-alpha'].getbbox())
        self.assertTrue(check['pass'],check);self.assertEqual(check['maximumChannelDifference'],0);self.assertEqual(check['opaqueInteriorChangedPixels'],0)

    def test_completed_hair_geometry_preserves_crown_owner_and_excludes_body_outside_head(self):
        size=(100,120);labels=Image.new('L',size,6);fg=Image.new('L',size,255);p2fg=Image.new('L',size)
        ImageDraw.Draw(labels).rectangle((10,0,25,65),fill=1)
        ImageDraw.Draw(labels).rectangle((75,0,90,65),fill=2)
        ImageDraw.Draw(p2fg).rectangle((30,20,70,119),fill=255)
        corrected,report,_=constrain_completed_labels(labels,fg,p2fg,landmarks())
        self.assertEqual(corrected.getpixel((20,5)),1)
        self.assertEqual(corrected.getpixel((20,30)),1)
        self.assertEqual(corrected.getpixel((27,30)),1)
        self.assertEqual(corrected.getpixel((73,30)),2)
        self.assertEqual(corrected.getpixel((50,40)),6)
        self.assertEqual(corrected.getpixel((10,110)),6)
        self.assertGreater(report['headExteriorNonHairToHairPixels'],0)

    def test_exposed_body_is_not_owned_by_the_face(self):
        labels=Image.new('L',(100,120),3);fg=Image.new('L',labels.size,255)
        labels.putpixel((20,105),4);labels.putpixel((21,105),7)
        labels.putpixel((22,105),5);labels.putpixel((23,105),1)
        corrected,report,_=constrain_completed_labels(labels,fg,fg,landmarks())
        self.assertEqual(corrected.getpixel((50,80)),3)
        for xy in [(50,110),(20,105),(21,105)]:self.assertEqual(corrected.getpixel(xy),6)
        self.assertEqual(corrected.getpixel((22,105)),5);self.assertEqual(corrected.getpixel((23,105)),1)
        self.assertEqual(report['headLabelsBelowCollarToBodyPixels'],2498)

    def test_completed_back_hair_fills_behind_face_and_body_stays_above_it(self):
        size=(20,20);source=Image.new('RGBA',size,(80,40,20,255));p1=Image.new('RGBA',size,(240,210,180,255));p2=p1.copy();p3=Image.new('RGBA',size,(120,60,30,255));fg=Image.new('L',size,255)
        labels=Image.new('L',size,2);ImageDraw.Draw(labels).rectangle((6,4,13,16),fill=3);ImageDraw.Draw(labels).rectangle((4,2,7,6),fill=1)
        p2fg=Image.new('L',size);ImageDraw.Draw(p2fg).rectangle((6,4,13,16),fill=255)
        p1hair=Image.new('L',size)
        p1hair.putpixel((7,4),255)
        # Registration may leave transparent padding with black RGB; it must
        # never become an opaque stripe in the completed hidden hair.
        p3.putpixel((10,15),(0,0,0,0))
        layers,comp,check,_=assemble_completed(source,p1,p2,p3,fg,labels,p1hair,fg,p2fg,fg)
        self.assertEqual(list(layers),['back hair','base','front hair'])
        self.assertEqual(layers['back hair'].getpixel((10,10)),p3.getpixel((10,10)))
        self.assertEqual(layers['back hair'].getpixel((10,15))[3],0)
        self.assertEqual(layers['base'].getpixel((4,2))[3],0)
        self.assertEqual(layers['base'].getpixel((6,4)),p1.getpixel((6,4)))
        self.assertEqual(layers['base'].getpixel((7,4))[3],0)
        self.assertEqual(layers['back hair'].getpixel((7,4)),p3.getpixel((7,4)))
        self.assertEqual(comp.tobytes(),source.tobytes());self.assertTrue(check['pass'])

    def test_generated_ownership_rounds_only_to_declared_palette(self):
        image=Image.new('RGB',(8,1));image.putdata([tuple(max(0,min(255,c+(-3 if c else 3))) for c in color) for color in COLORS[:8]])
        self.assertEqual(list(nearest_labels(image).tobytes()),list(range(8)))

    def test_boundary_snap_uses_source_edge_and_never_extends_past_three_pixels(self):
        size=(50,30);source=Image.new('RGBA',size,(250,220,190,255))
        ImageDraw.Draw(source).rectangle((0,0,19,29),fill=(80,40,20,255))
        labels=Image.new('L',size,3);ImageDraw.Draw(labels).rectangle((0,0,21,29),fill=1)
        fg=Image.new('L',size,255);snapped,report,_=snap_boundaries(source,labels,fg)
        self.assertEqual(snapped.getpixel((19,15)),1);self.assertEqual(snapped.getpixel((20,15)),3)
        self.assertEqual(snapped.getpixel((21,15)),3);self.assertEqual(snapped.getpixel((5,15)),1)
        self.assertLessEqual(report['maximumBoundedDisplacement'],3)
        missing=labels.copy();ImageDraw.Draw(missing).rectangle((0,0,10,29),fill=0)
        incomplete,report,_=snap_boundaries(source,missing,fg)
        self.assertEqual(incomplete.getpixel((2,15)),0)
        self.assertGreater(report['unassignedVisiblePixels'],0);self.assertFalse(report['completeWithinRadius'])

    def test_visible_ownership_ignores_image_difference_and_audits_missing_labels(self):
        size=(20,20);source=Image.new('RGBA',size,(80,40,20,255));p1=source.copy();p2=Image.new('RGBA',size,(250,220,190,255))
        fg=Image.new('L',size,255);labels=Image.new('L',size,3)
        ImageDraw.Draw(labels).rectangle((2,2,8,12),fill=1)
        ImageDraw.Draw(labels).rectangle((9,2,12,12),fill=2);labels.putpixel((18,18),0)
        p1hair=Image.new('L',size,255)
        layers,composite,check,_=assemble_owned(source,p1,p2,fg,labels,p1hair,fg,fg)
        self.assertTrue(check['pass']);self.assertEqual(check['unassignedPixels'],1)
        self.assertEqual(composite.tobytes(),source.tobytes())
        # Even identical P0/P1 colors belong to front hair when the map says so.
        self.assertEqual(layers['front hair'].getpixel((5,5)),source.getpixel((5,5)))
        self.assertEqual(layers['back hair'].getpixel((5,5)),p1.getpixel((5,5)))
        self.assertEqual(layers['base'].getpixel((5,5)),p2.getpixel((5,5)))
        self.assertEqual(layers['unassigned'].getpixel((18,18)),source.getpixel((18,18)))

    def test_peel_keeps_original_visible_pixels_and_uses_drawn_hidden_surfaces(self):
        size=(64,60);zero=Image.new('L',size);fg=zero.copy()
        ImageDraw.Draw(fg).rectangle((3,3,60,56),fill=255)
        p2=Image.new('RGBA',size,(250,220,190,255));p1=p2.copy()
        ImageDraw.Draw(p1).rectangle((10,10,35,40),fill=(120,60,30,255))
        source=p1.copy();ImageDraw.Draw(source).rectangle((20,8,45,38),fill=(40,20,10,255))
        hair1=zero.copy();ImageDraw.Draw(hair1).rectangle((10,10,35,40),fill=255)
        hair0=hair1.copy();ImageDraw.Draw(hair0).rectangle((20,8,45,38),fill=255)
        p1.putpixel((50,50),(180,150,120,255));p2.putpixel((50,50),(180,150,120,255))
        layers,comp,check,_=peeled_layers(source,p1,p2,fg,hair0,hair1,fg)
        self.assertTrue(check['pass']);self.assertEqual(check['changedPixels'],0)
        self.assertEqual(layers['front hair'].getpixel((25,20)),source.getpixel((25,20)))
        self.assertEqual(layers['back hair'].getpixel((25,20)),p1.getpixel((25,20)))
        self.assertEqual(layers['base'].getpixel((25,20)),p2.getpixel((25,20)))
        self.assertEqual(comp.getpixel((50,50)),source.getpixel((50,50)))
        self.assertEqual(comp.getpixel((0,0)),(0,0,0,0))

    def test_schema_rejects_polygons_nonfinite_and_wrong_canvas(self):
        valid=landmarks(); self.assertIs(validate_landmarks(valid,(100,120)),valid)
        for mutate in (lambda d:d.update(polygons=[]),lambda d:d.update(chin=[float('nan'),70]),lambda d:d.update(canvas=[120,100]),lambda d:d['eyes'][0].update(width=-1),lambda d:d.update(bangTips=[[2,2]])):
            bad=copy.deepcopy(valid); mutate(bad)
            with self.assertRaises(ValueError):validate_landmarks(bad,(100,120))

    def test_accessories_follow_existing_layer_contract(self):
        data=landmarks(); data['accessories']=[{'layer':'headwear','box':{'center':[50,15],'width':30,'height':20}}]
        validate_landmarks(data,(100,120),{'headwear'})
        data['accessories'][0]['layer']='unknown'
        with self.assertRaises(ValueError):validate_landmarks(data,(100,120),{'headwear'})

    def test_rows_bridge_only_between_existing_bundles(self):
        im=Image.new('L',(12,6)); p=im.load();p[2,2]=p[8,2]=255;p[5,4]=255
        filled=row_fill(im)
        self.assertEqual([filled.getpixel((x,2)) for x in range(12)],[0,0]+[255]*7+[0]*3)
        self.assertEqual(filled.getpixel((4,4)),0);self.assertEqual(filled.getpixel((6,3)),0)

    def test_palette_discards_distant_contour_family(self):
        im=Image.new('RGB',(80,80),(210,180,160)); d=ImageDraw.Draw(im);d.rectangle((0,0,12,79),fill=(20,12,5))
        colors=flat_palette(im,Image.new('L',im.size,255),dominant=True)
        self.assertIn((210,180,160),colors);self.assertNotIn((20,12,5),colors)

    def test_palette_follows_unusual_skin_colour(self):
        im=Image.new('RGB',(30,30),(30,180,210))
        self.assertEqual(flat_palette(im,Image.new('L',im.size,255),dominant=True),[(30,180,210)])

    def test_dark_path_follows_ink_inside_source_corridor(self):
        im=Image.new('RGB',(60,70),(170,100,60)); d=ImageDraw.Draw(im)
        d.line([(45,0),(45,69)],fill=(20,8,2),width=2)
        hair=Image.new('L',im.size,255);inner=Image.new('L',im.size);ImageDraw.Draw(inner).rectangle((18,0,30,69),fill=255)
        path=darkest_path(im,hair,inner,'right',0,70)
        self.assertEqual(len(path),70);self.assertTrue(all(44<=x<=46 for x,y in path))
        self.assertTrue(all(abs(a[0]-b[0])<=3 for a,b in zip(path,path[1:])))

    def test_background_is_estimated_from_border(self):
        im=Image.new('RGB',(40,40),(245,247,249));ImageDraw.Draw(im).ellipse((8,3,32,37),fill=(80,40,20))
        fg,report=foreground_mask(im)
        self.assertEqual(fg.getpixel((0,0)),0);self.assertEqual(fg.getpixel((20,20)),255)
        self.assertEqual(report['rgb'],(245,247,249))

    def test_white_unmatting_preserves_appearance_without_expanding_support(self):
        im=Image.new('RGB',(30,30),'white');d=ImageDraw.Draw(im)
        d.rectangle((5,5,24,24),fill=(150,120,100));d.rectangle((6,6,23,23),fill=(45,20,10))
        fg=Image.new('L',im.size);ImageDraw.Draw(fg).rectangle((5,5,24,24),fill=255)
        result=unmatte_white(im,fg);flat=Image.new('RGBA',im.size,'white');flat.alpha_composite(result)
        delta=ImageChops.difference(flat.convert('RGB'),im)
        self.assertLessEqual(max(delta.getextrema()[c][1] for c in range(3)),1)
        self.assertEqual(result.getpixel((4,5))[3],0)

    def test_hair_unmatting_recovers_enclosed_background_edges_without_repainting(self):
        im=Image.new('RGB',(50,50),'white');d=ImageDraw.Draw(im)
        d.rectangle((5,5,44,44),fill=(45,20,10))
        d.rectangle((20,20,29,29),fill=(150,120,100));d.rectangle((22,22,27,27),fill='white')
        fg=Image.new('L',im.size);d=ImageDraw.Draw(fg)
        d.rectangle((5,5,44,44),fill=255);d.rectangle((22,22,27,27),fill=0)
        result=unmatte_white(im,fg,edge_width=2,enclosed_gaps=True)
        self.assertLess(result.getpixel((21,25))[3],255)
        self.assertEqual(result.getpixel((25,25))[3],0)
        flat=Image.new('RGBA',im.size,'white');flat.alpha_composite(result)
        self.assertLessEqual(max(hi for lo,hi in ImageChops.difference(flat.convert('RGB'),im).getextrema()),1)
        self.assertEqual(result.getchannel('A').point(lambda v:255 if v else 0).tobytes(),fg.tobytes())

    def test_white_unmatting_keeps_internal_boundary_opaque(self):
        im=Image.new('RGB',(50,50),'white');d=ImageDraw.Draw(im)
        d.rectangle((5,5,44,44),fill=(150,120,100));d.rectangle((6,6,43,43),fill=(45,20,10))
        d.rectangle((20,20,29,29),fill=(150,120,100));d.rectangle((22,22,27,27),fill='white')
        fg=Image.new('L',im.size);d=ImageDraw.Draw(fg)
        d.rectangle((5,5,44,44),fill=255);d.rectangle((22,22,27,27),fill=0)
        result=unmatte_white(im,fg,edge_width=2)
        self.assertLess(result.getpixel((5,25))[3],255)
        self.assertEqual(result.getpixel((21,25)),im.getpixel((21,25))+(255,))
        self.assertEqual(result.getpixel((25,25))[3],0)
        flat=Image.new('RGBA',im.size,'white');flat.alpha_composite(result)
        delta=ImageChops.difference(flat.convert('RGB'),im)
        self.assertLessEqual(max(hi for lo,hi in delta.getextrema()),1)

    def test_shadow_transfer_preserves_composite_and_removes_fixed_face_shadow(self):
        size=(10,10);original=Image.new('RGBA',size,(190,120,70,255));face=original.copy()
        front=Image.new('RGBA',size);skin=Image.new('RGB',size,(245,210,170));mask=Image.new('L',size,255)
        self.assertEqual(move_shadows(original,face,front,skin,mask),100)
        self.assertEqual(face.getpixel((5,5)),(245,210,170,255))
        face.alpha_composite(front);delta=ImageChops.difference(face,original)
        self.assertLessEqual(max(hi for lo,hi in delta.getextrema()),1)

    def test_square_padding_roundtrips_odd_portrait_and_landscape(self):
        for size in [(15,8),(8,15),(9,9)]:
            im=Image.new('RGBA',size,(12,34,56,123));padded,padding=square_pad(im)
            self.assertEqual(padded.width,padded.height)
            self.assertEqual(square_unpad(padded,padding).tobytes(),im.tobytes())

    def test_conservation_retains_transparent_shadow_over_clean_face(self):
        size=(12,10);source=Image.new('RGBA',size,'white')
        ImageDraw.Draw(source).rectangle((2,2,9,8),fill=(190,120,70,255))
        zero=Image.new('L',size);foreground=zero.copy()
        ImageDraw.Draw(foreground).rectangle((2,2,9,8),fill=255)
        layers={n:Image.new('RGBA',size) for n in ORDER}
        layers['face']=source.copy()
        move_shadows(source,layers['face'],layers['front hair'],Image.new('RGB',size,(245,210,170)),foreground)
        masks={n:zero.copy() for n in ('hair','topwear-visible','neck-visible','ears-visible','front')}
        masks.update({'foreground':foreground,'face-visible':foreground,'shadow':foreground})
        output,comp,report,_=conserve_visible_pixels(source,layers,masks)
        self.assertTrue(report['pass'])
        self.assertLess(output['front hair'].getpixel((5,5))[3],255)
        self.assertEqual(output['face'].getpixel((5,5)),(245,210,170,255))
        self.assertEqual(comp.getpixel((5,5)),source.getpixel((5,5)))

    def test_accessory_source_ownership_resolves_shadow_over_actual_underlay(self):
        size=(12,10);source=Image.new('RGBA',size,'white')
        ImageDraw.Draw(source).rectangle((2,2,9,8),fill=(190,120,70,255))
        zero=Image.new('L',size);foreground=zero.copy()
        ImageDraw.Draw(foreground).rectangle((2,2,9,8),fill=255)
        for accessory in ('eyewear','headwear'):
            lm=landmarks()
            lm.update({'ears':[{'center':[2,5],'width':2,'height':4},{'center':[9,5],'width':2,'height':4}],
                       'eyes':[{'center':[4,4],'width':2,'height':2},{'center':[8,4],'width':2,'height':2}],
                       'hairPart':[6,1],'chin':[6,8],'collar':[[2,8],[6,9],[9,8]]})
            lm['accessories']=[{'layer':accessory,'box':{'center':[6,5],'width':6,'height':6}}]
            foreground,_=foreground_mask(source.convert('RGB'),lm)
            layers={n:Image.new('RGBA',size) for n in ORDER}
            layers['face']=source.copy();layers[accessory]=source.copy()
            move_shadows(source,layers['face'],layers['front hair'],Image.new('RGB',size,(245,210,170)),foreground)
            shadow=zero.copy();shadow.putpixel((5,5),255)
            masks={n:zero.copy() for n in ('hair','topwear-visible','neck-visible','ears-visible','front')}
            masks.update({'foreground':foreground,'face-visible':foreground,'shadow':shadow})
            output,comp,report,_=conserve_visible_pixels(source,layers,masks,lm)
            self.assertTrue(report['pass'])
            self.assertEqual(comp.getpixel((5,5)),source.getpixel((5,5)))
            self.assertGreater(report['layers'][accessory]['visible'],0)
            self.assertEqual(output[accessory].getpixel((6,5)),source.getpixel((6,5)))
            if accessory=='eyewear':
                self.assertEqual(report['shadowsResolvedOverActualUnderlay'],1)
                self.assertLess(output['front hair'].getpixel((5,5))[3],255)

    def test_eye_backing_does_not_take_visible_skin_ownership(self):
        size=(12,10);source=Image.new('RGBA',size,'white')
        ImageDraw.Draw(source).rectangle((2,2,9,8),fill=(245,210,170,255))
        source.putpixel((5,5),(80,40,20,255));source.putpixel((6,5),(240,240,240,255))
        zero=Image.new('L',size);foreground=zero.copy()
        ImageDraw.Draw(foreground).rectangle((2,2,9,8),fill=255)
        layers={n:Image.new('RGBA',size) for n in ORDER};layers['face']=source.copy()
        ImageDraw.Draw(layers['eyewhite']).rectangle((4,4,7,6),fill=(240,240,240,255))
        layers['irides'].putpixel((5,5),source.getpixel((5,5)))
        visible=zero.copy();visible.putpixel((6,5),255)
        masks={n:zero.copy() for n in ('hair','topwear-visible','neck-visible','ears-visible','front','shadow')}
        masks.update({'foreground':foreground,'face-visible':foreground,'eyewhite-visible':visible})
        output,_,report,_=conserve_visible_pixels(source,layers,masks)
        self.assertTrue(report['pass'])
        self.assertEqual(output['eyewhite'].getpixel((5,5)),(240,240,240,255))
        self.assertEqual(output['eyewhite'].getpixel((4,4))[3],0)
        self.assertEqual(output['face'].getpixel((4,4)),source.getpixel((4,4)))

    def test_visible_ownership_clips_hidden_face_and_preserves_every_source_pixel(self):
        size=(12,10); source=Image.new('RGBA',size,'white');ImageDraw.Draw(source).rectangle((2,2,9,8),fill=(180,70,20,255))
        layers={n:Image.new('RGBA',size) for n in ORDER}
        layers['face']=Image.new('RGBA',size,(250,220,190,255))
        layers['front hair']=Image.new('RGBA',size,(10,10,10,255))
        zero=Image.new('L',size); foreground=zero.copy();ImageDraw.Draw(foreground).rectangle((2,2,9,8),fill=255)
        masks={n:zero.copy() for n in ('hair','topwear-visible','neck-visible','ears-visible','face-visible','shadow')}
        masks.update({'foreground':foreground,'front':foreground})
        output,comp,report,owners=conserve_visible_pixels(source,layers,masks)
        self.assertTrue(report['pass']);self.assertEqual(report['foregroundPixels'],56)
        self.assertEqual(report['assignedVisiblePixels'],56);self.assertEqual(report['changedPixels'],0)
        self.assertEqual(output['face'].getpixel((0,0))[3],0)
        self.assertEqual(output['face'].getpixel((4,4)),(250,220,190,255))
        self.assertEqual(comp.getpixel((4,4)),source.getpixel((4,4)))
        # A missing source pixel must fail even if the partition claims it is background.
        masks['foreground'].putpixel((4,4),0)
        _,_,failed,_=conserve_visible_pixels(source,layers,masks)
        self.assertFalse(failed['pass']);self.assertEqual(failed['missingSourceForegroundPixels'],1)
        self.assertEqual(failed['changedPixels'],1)

    def test_source_background_rule_removes_closed_hair_gaps_but_keeps_white_eyes(self):
        rgb=Image.new('RGB',(100,120),'white');d=ImageDraw.Draw(rgb)
        d.rectangle((5,5,94,115),fill=(80,40,20));d.rectangle((8,12,12,18),fill='white')
        d.rectangle((32,42,38,46),fill='white');d.rectangle((26,108,30,112),fill='white')
        fg,_=foreground_mask(rgb,landmarks())
        self.assertEqual(fg.getpixel((10,15)),0)
        self.assertEqual(fg.getpixel((35,44)),255);self.assertEqual(fg.getpixel((28,110)),255)

    def test_generation_scope_excludes_padding_and_unused_hair_tips(self):
        source=Image.new('RGBA',(100,120),'white');editable=Image.new('L',(120,120))
        d=ImageDraw.Draw(editable);d.rectangle((40,20,60,45),fill=255);d.rectangle((0,110,10,119),fill=255)
        item={'cropBox':[0,0,100,120],'padding':[10,0,10,0]}
        used,band,support=validation_scope(source,landmarks(),item,editable)
        self.assertEqual(used.getpixel((50,35)),255);self.assertEqual(used.getpixel((5,115)),0)
        self.assertEqual(band.getpixel((63,35)),255);self.assertEqual(band.getpixel((5,108)),0)
        self.assertIsNone(ImageChops.subtract(band,support).getbbox())

    def test_request_crop_contains_complete_hair_and_protects_padding(self):
        with tempfile.TemporaryDirectory() as temp:
            source=Image.new('RGBA',(100,120),'white')
            hair=Image.new('L',source.size);ImageDraw.Draw(hair).rectangle((10,5,90,110),fill=255)
            front=Image.new('L',source.size);ImageDraw.Draw(front).rectangle((30,20,60,40),fill=255)
            root=Path(temp);record=build_request(root,source,landmarks(),{'hair':hair,'front':front})
            self.assertGreater(record['cropBox'][3],110)
            mask_image=Image.open(root/'requests'/'without-front-hair'/'mask.png')
            self.assertEqual(mask_image.getpixel((0,0))[3],255)
            self.assertEqual(record['size'][0],record['size'][1])

    def test_hidden_import_keeps_original_visible_pixels_and_records_diagnostic_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); request=root/'requests'/'without-front-hair'; request.mkdir(parents=True)
            (root/'results').mkdir();(root/'masks').mkdir()
            source=Image.new('RGBA',(120,120),'white'); draw=ImageDraw.Draw(source)
            draw.rectangle((25,51,85,95),fill=(250,220,190,255));draw.rectangle((20,10,90,50),fill=(80,40,20,255))
            hair=Image.new('L',source.size);ImageDraw.Draw(hair).rectangle((20,10,90,50),fill=255)
            hair.save(root/'masks'/'hair.png');source.save(request/'input.png')
            edit=Image.new('RGBA',source.size,'white');edit.putalpha(ImageChops.invert(hair));edit.save(request/'mask.png')
            metadata={'cropBox':[0,0,120,120],'padding':[0,0,0,0],'size':[120,120],
                      'inputSha256':file_hash(request/'input.png'),'maskSha256':file_hash(request/'mask.png')}
            (root/'requests.json').write_text(json.dumps(metadata));(root/'landmarks.json').write_text(json.dumps(landmarks()))
            (root/'segmentation.json').write_text(json.dumps({'palettes':{'hair':[[80,40,20]],'skin':[[250,220,190]],'neck':[]}}))
            generated=source.copy();ImageDraw.Draw(generated).rectangle((35,20,75,50),fill=(250,220,190,255))
            generated.save(root/'results'/'without-front-hair.png')
            (accepted,used,threshold),report=checked_result(root,root/'results',source)
            self.assertTrue(report['pass']);self.assertEqual(report['thresholds'],{'mean':6,'p99':20,'local':24,'flat':12})
            self.assertEqual(used.getpixel((55,35)),255);self.assertEqual(used.getpixel((55,54)),0)
            self.assertEqual(accepted.getpixel((55,35)),(250,220,190,255))
            self.assertEqual(accepted.getpixel((55,54)),source.getpixel((55,54)))
            ImageDraw.Draw(generated).rectangle((52,52,58,57),fill=(20,20,20,255))
            generated.save(root/'results'/'without-front-hair.png')
            (accepted,used,_),diagnostic=checked_result(root,root/'results',source)
            self.assertTrue(diagnostic['pass']);self.assertEqual(diagnostic['thresholds'],report['thresholds'])
            self.assertFalse(diagnostic['pixelComparison']['gating'])
            self.assertFalse(diagnostic['pixelComparison']['withinReferenceLimits'])
            self.assertEqual(diagnostic['qualityReview']['status'],'pending')
            self.assertEqual(accepted.getpixel((55,54)),source.getpixel((55,54)))
            outside=ImageChops.invert(used)
            self.assertIsNone(ImageChops.multiply(ImageChops.difference(accepted,source).getchannel('R'),outside).getbbox())

    def test_hair_to_background_and_other_hair_edits_are_not_consumed(self):
        source=Image.new('RGBA',(60,40),(80,40,20,255));generated=source.copy()
        d=ImageDraw.Draw(generated);d.rectangle((5,5,20,25),fill=(250,220,190,255))
        d.rectangle((30,5,40,25),fill='white');d.rectangle((45,5,55,25),fill=(110,50,20,255))
        # Closed dark eyebrow and white-eye holes inside the revealed face remain consumed.
        d.rectangle((10,10,14,11),fill=(80,40,20,255));d.rectangle((10,15,14,17),fill='white')
        used,excluded=removed_hair(source,generated,Image.new('L',source.size,255),
                                   {'skin':[[250,220,190]],'hair':[[80,40,20],[110,50,20]],'neck':[]})
        self.assertEqual(used.getpixel((12,8)),255);self.assertEqual(used.getpixel((12,10)),255)
        self.assertEqual(used.getpixel((12,16)),255)
        self.assertEqual(used.getpixel((35,10)),0);self.assertEqual(excluded['background'].getpixel((35,10)),255)
        self.assertEqual(used.getpixel((50,10)),0);self.assertEqual(excluded['hair'].getpixel((50,10)),255)

    def test_surface_rejects_thin_tan_fringe_and_keeps_ear_beneath_front_lock(self):
        generated=Image.new('RGBA',(120,120),'white');draw=ImageDraw.Draw(generated)
        draw.rectangle((10,5,109,90),fill=(80,40,20,255))
        draw.ellipse((35,12,85,85),fill=(250,220,190,255))
        draw.ellipse((15,50,31,77),fill=(250,220,190,255));draw.ellipse((89,50,105,77),fill=(250,220,190,255))
        draw.rectangle((47,38,55,44),fill=(80,40,20,255));draw.rectangle((48,39,50,41),fill='white')
        draw.line((112,8,112,85),fill=(231,217,201,255),width=1)
        lm=landmarks();lm['eyes']=[{'center':[45,44],'width':16,'height':14},{'center':[72,44],'width':16,'height':14}]
        lm['chin']=[60,85];lm['ears']=[{'center':[23,64],'width':20,'height':32},{'center':[97,64],'width':20,'height':32}]
        surface=generated_face_surface(generated,{'skin':[[250,220,190]],'hair':[[80,40,20]],'neck':[]},lm,
                                        {'cropBox':[0,0,120,120],'padding':[0,0,0,0]})
        self.assertEqual(surface.getpixel((112,50)),0)
        self.assertEqual(surface.getpixel((23,64)),255);self.assertEqual(surface.getpixel((97,64)),255)
        self.assertEqual(surface.getpixel((49,40)),255);self.assertEqual(surface.getpixel((53,40)),255)
        source_hair=Image.new('L',generated.size);ImageDraw.Draw(source_hair).rectangle((14,48,32,80),fill=255)
        used=ImageChops.multiply(source_hair,surface)
        self.assertEqual(used.getpixel((23,64)),255)

    def test_bundle_declares_engine_and_verifiable_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'layers').mkdir();(root/'landmarks.json').write_text('{}')
            Image.new('RGBA',(12,12),(10,20,30,255)).save(root/'layers'/'face.png')
            result=bundle(root,{'input':{'sha256':'a'*64}},{'method':'difference','canvas':[12,12],'limitations':['preview']})
            import zipfile
            with zipfile.ZipFile(result) as z:
                manifest=json.loads(z.read('run-manifest.json'))
                self.assertFalse(manifest['engine']['seeThroughExecuted']);self.assertTrue(manifest['engine']['imageGenerationUsed'])
                self.assertEqual(manifest['artifacts'][0]['sha256'],file_hash(root/'layers'/'face.png'))
                self.assertIn('layerdiff_output/source/face.png',z.namelist())

    def test_split_rejects_removed_method_and_unverified_legacy_bundle(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            result=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'scripts/split_image.py'),
                                   'auto','--job-root',temp,'--method','dark-path'],capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            self.assertIn('invalid choice',result.stderr)
            self.assertFalse((Path(temp)/'split').exists())
            with self.assertRaises(ValueError):
                bundle(Path(temp),{'input':{'sha256':'a'*64}},
                       {'method':'unsupported','canvas':[12,12],'limitations':['preview']})


if __name__=='__main__':unittest.main()
