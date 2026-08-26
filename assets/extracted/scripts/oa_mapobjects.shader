
models/mapobjects/torch/torchnew
{
 	cull disable
 	//surfaceparm trans
 	{
 		map models/mapobjects/torch/torchnew.tga
	//	alphaFunc GE128
	//	depthWrite
 		rgbGen lightingDiffuse
 	}

 	{
 	//	map models/mapobjects/torch/torchnew.tga
 	//	blendfunc gl_src_alpha gl_one
 	//	rgbGen lightingDiffuse
 	//	depthFunc equal
 	//	alphaGen lightingSpecular
 	//	detail
 	}

 	{
 		map gfx/fx/detail/d_met.tga
 		blendfunc gl_dst_color gl_src_color
 		rgbGen identity
 		tcMod scale 5 10
 		detail
 	}

}



// FIXME: Broken?
models/mapobjects/fan/fanbroken
{
	{
		map models/mapobjects/fan/fan.tga
		rgbGen lightingDiffuse
	}
	{
		map gfx/fx/detail/d_met2.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale 8 8
		detail
	}
	{
		map gfx/fx/spec/robawt.tga
		blendfunc gl_dst_color gl_one
		rgbGen identity
		tcGen environment 
		detail
	}
}

